const os = require('os')
const fs = require('fs')
const path = require('path')
const net = require('net')
const axios = require('axios')
const { Client } = require('ssh2')

const DEFAULT_DISCOVERY_TIMEOUT_MS = 350
const DEFAULT_DISCOVERY_PORT = 22
const DEFAULT_DISCOVERY_HTTP_PORT = 80
const DEFAULT_DISCOVERY_RPC_TIMEOUT_MS = 1500
const DEFAULT_WS_URL = 'ws://nodes.techkovery.eu/ws'
const UPDATES_BASE_URL = 'https://updates.techkovery.eu'
const UPDATES_APP = 'tkounter'
const UPDATES_FLAVOR = 'techkovery'

const GL_INET_DISCOVERY_PAYLOAD = {
    jsonrpc: '2.0',
    id: 1,
    method: 'call',
    params: ['', 'ui', 'check_initialized', {}]
}

function normalizeBaseUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '')
}

function normalizeWsUrl(wsUrl) {
    const normalized = String(wsUrl || '').trim()
    if (!normalized) {
        return DEFAULT_WS_URL
    }

    if (!/^ws:\/\//i.test(normalized)) {
        throw new Error('Invalid WS URL: it must start with ws://')
    }

    return normalized
}

// Wraps a value in single quotes so it can be safely interpolated into a shell
// command sent over SSH, regardless of its content (spaces, UTF-8, quotes,
// `$`, backticks, etc.). This is required now that node names accept
// arbitrary UTF-8 text, to prevent shell/command injection on the node.
function shellSingleQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`
}

// Matches the uuid v4-ish strings generate_uuid_v4() in prepare-node.sh
// produces (36 lowercase hex chars + dashes). Used to validate `forceUuid`
// (re-provisioning an existing node) before it ever touches a shell command.
const NODE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const NODE_SCRIPTS_DIR = path.join(__dirname, 'node-scripts')

// Reads one of the shell/JSON templates under src/node-scripts, stripping the
// trailing newline so callers can freely join it with other lines.
function readNodeScript(name) {
    return fs.readFileSync(path.join(NODE_SCRIPTS_DIR, name), 'utf8').replace(/\n$/, '')
}

// Reads a node-scripts template and replaces its __TOKEN__ placeholders with
// literal values (split/join, not regex, so replacement values can't be
// misread as patterns). All substitution happens here, locally, before the
// result is ever sent to the node - the node never has to run `sed` on it.
function renderNodeScript(name, replacements) {
    let content = readNodeScript(name)
    for (const [token, value] of Object.entries(replacements)) {
        content = content.split(`__${token}__`).join(value)
    }
    return content
}

// Escapes a value so it can be embedded inside a double-quoted string in a
// generated shell script file (e.g. SERVER="__SERVER__"). The value becomes
// literal file content on the node, later interpreted by /bin/sh when that
// script runs, so it still needs shell-safe escaping at that point.
function escapeForDoubleQuotedShellLiteral(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')
}

// Escapes a value for embedding inside a JSON string literal in a template.
function escapeForJsonLiteral(value) {
    return JSON.stringify(String(value)).slice(1, -1)
}

// Builds the unified shell script installed on the node that keeps the SSH
// hostname in sync with the (possibly duplicated) descriptive node name.
// It writes /etc/tkounter/node_name and derives a unique system hostname as
// tk-<slugified-name>-<first 6 chars of node_uuid>. It is installed once
// during provisioning but is designed to be re-invoked later (e.g. by the
// tkounter binary) whenever the backend renames the node, so both paths stay
// unified in a single place.
function buildHostnameScriptInstallCommand() {
    return [
        'set -e',
        'mkdir -p /etc/tkounter',
        'cat > /usr/bin/tkounter-hostname.sh <<"EOT"',
        readNodeScript('tkounter-hostname.sh'),
        'EOT',
        'chmod +x /usr/bin/tkounter-hostname.sh'
    ].join('\n')
}

function isPrivateIPv4(ip) {
    if (!ip || typeof ip !== 'string') return false
    return ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
}

// Subnets wider than /20 (>4096 hosts) are not fully expanded to avoid scans that would
// take unreasonably long; in that case we fall back to the exact /24 of the interface address.
const MIN_EXPANDABLE_PREFIX_LENGTH = 20

function ipToInt(ip) {
    const parts = ip.split('.').map(Number)
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function intToIp(int) {
    return [24, 16, 8, 0].map((shift) => (int >>> shift) & 255).join('.')
}

function netmaskToPrefixLength(netmask) {
    if (!netmask || typeof netmask !== 'string') return null
    const parts = netmask.split('.').map(Number)
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null
    return parts.reduce((acc, octet) => acc + octet.toString(2).split('1').length - 1, 0)
}

function getPrefixLength(item) {
    if (typeof item.cidr === 'string') {
        const match = item.cidr.match(/\/(\d{1,2})$/)
        if (match) return Number(match[1])
    }
    return netmaskToPrefixLength(item.netmask)
}

// Returns the list of /24 blocks ("a.b.c") that need to be scanned to cover the real
// subnet of a given interface, not just the /24 that happens to contain its own address.
// This matters on office/corporate networks that use a mask wider than /24 (e.g. /22, /20),
// where the target node can sit in a different third octet than the scanning machine.
function getSubnetPrefixesForInterface(item) {
    const parts = item.address.split('.')
    if (parts.length !== 4) return []
    const exactPrefix = `${parts[0]}.${parts[1]}.${parts[2]}`

    const prefixLength = getPrefixLength(item)
    if (prefixLength === null || prefixLength >= 24 || prefixLength < MIN_EXPANDABLE_PREFIX_LENGTH) {
        return [exactPrefix]
    }

    const addressInt = ipToInt(item.address)
    const maskInt = (0xFFFFFFFF << (32 - prefixLength)) >>> 0
    const networkInt = (addressInt & maskInt) >>> 0
    const hostBits = 32 - prefixLength
    const blockCount = Math.max(1, Math.ceil(2 ** hostBits / 256))

    const prefixes = []
    for (let i = 0; i < blockCount; i += 1) {
        const blockBaseOctets = intToIp((networkInt + i * 256) >>> 0).split('.')
        prefixes.push(`${blockBaseOctets[0]}.${blockBaseOctets[1]}.${blockBaseOctets[2]}`)
    }
    return prefixes
}

function getCandidatePrefixes() {
    const prefixes = new Set(['192.168.8'])
    const interfaces = os.networkInterfaces()

    for (const list of Object.values(interfaces)) {
        if (!Array.isArray(list)) continue
        for (const item of list) {
            if (item.family !== 'IPv4' || item.internal) continue
            if (!isPrivateIPv4(item.address)) continue

            for (const prefix of getSubnetPrefixesForInterface(item)) {
                prefixes.add(prefix)
            }
        }
    }

    return [...prefixes]
}

function checkPortOpen(ip, port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = new net.Socket()
        let done = false

        const finish = (ok) => {
            if (done) return
            done = true
            socket.destroy()
            resolve(ok)
        }

        socket.setTimeout(timeoutMs)
        socket.once('connect', () => finish(true))
        socket.once('timeout', () => finish(false))
        socket.once('error', () => finish(false))
        socket.connect(port, ip)
    })
}

async function runInBatches(items, batchSize, mapper) {
    const result = []
    for (let i = 0; i < items.length; i += batchSize) {
        const chunk = items.slice(i, i + batchSize)
        const mapped = await Promise.all(chunk.map(mapper))
        result.push(...mapped)
    }
    return result
}

async function probeGlInetRpc(ip, timeoutMs) {
    try {
        const response = await axios.post(`http://${ip}/rpc`, GL_INET_DISCOVERY_PAYLOAD, {
            timeout: timeoutMs,
            headers: {
                Accept: 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                Origin: `http://${ip}`,
                Referer: `http://${ip}/`
            }
        })

        const result = response.data?.result
        if (!result || typeof result !== 'object') {
            return null
        }

        const model = String(result.model || '').trim()
        const hostname = String(result.hostname || '').trim()
        if (!model && !hostname) {
            return null
        }

        return {
            ip,
            hostname: hostname || 'unknown',
            model: model || 'unknown',
            firmwareVersion: String(result.firmware_version || 'unknown').trim() || 'unknown',
            mac: String(result.mac || 'unknown').trim() || 'unknown',
            initialized: Boolean(result.initialized),
            isGlInet: true
        }
    } catch {
        return null
    }
}

async function discoverNodes({
    timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
    port = DEFAULT_DISCOVERY_PORT,
    httpPort = DEFAULT_DISCOVERY_HTTP_PORT,
    rpcTimeoutMs = DEFAULT_DISCOVERY_RPC_TIMEOUT_MS,
    maxHostsPerPrefix = 50
} = {}) {
    const prefixes = getCandidatePrefixes()
    const addresses = []

    for (const prefix of prefixes) {
        for (let i = 1; i <= 254; i += 1) {
            addresses.push(`${prefix}.${i}`)
        }
    }

    const httpScanResult = await runInBatches(addresses, maxHostsPerPrefix, async (ip) => {
        const open = await checkPortOpen(ip, httpPort, timeoutMs)
        return { ip, open }
    })

    const httpReachable = httpScanResult.filter((candidate) => candidate.open).map((candidate) => candidate.ip)
    const glInetDevices = await runInBatches(httpReachable, Math.max(8, Math.floor(maxHostsPerPrefix / 2)), async (ip) => {
        const device = await probeGlInetRpc(ip, rpcTimeoutMs)
        if (!device) {
            return null
        }

        const sshReachable = await checkPortOpen(ip, port, timeoutMs)
        return {
            ...device,
            sshReachable
        }
    })

    return glInetDevices.filter(Boolean)
}

function sshExec({ host, username, password, command, timeoutMs = 30000, onOutput = null }) {
    return new Promise((resolve, reject) => {
        const conn = new Client()
        let stdout = ''
        let stderr = ''
        let timeoutHandle

        const cleanup = () => {
            if (timeoutHandle) clearTimeout(timeoutHandle)
            conn.end()
        }

        conn.on('ready', () => {
            conn.exec(command, (err, stream) => {
                if (err) {
                    cleanup()
                    reject(err)
                    return
                }

                stream.on('close', (code) => {
                    cleanup()
                    if (code === 0) {
                        resolve({ stdout, stderr, code })
                    } else {
                        const error = new Error(`SSH command failed with code ${code}: ${stderr || stdout}`)
                        error.code = code
                        reject(error)
                    }
                })

                stream.on('data', (data) => {
                    const chunk = data.toString('utf8')
                    stdout += chunk
                    if (typeof onOutput === 'function') {
                        onOutput(chunk)
                    }
                })

                stream.stderr.on('data', (data) => {
                    const chunk = data.toString('utf8')
                    stderr += chunk
                    if (typeof onOutput === 'function') {
                        onOutput(`[stderr] ${chunk}`)
                    }
                })
            })
        }).on('error', reject).connect({
            host,
            username,
            password,
            readyTimeout: timeoutMs
        })

        timeoutHandle = setTimeout(() => {
            cleanup()
            reject(new Error(`SSH timeout after ${timeoutMs}ms`))
        }, timeoutMs + 1000)
    })
}

async function inspectNode({ host, username, password }) {
    const command = [
        'set -e',
        'uuid=""',
        '[ -f /etc/tkounter/node_uuid ] && uuid=$(cat /etc/tkounter/node_uuid)',
        'node_name=""',
        '[ -f /etc/tkounter/node_name ] && node_name=$(cat /etc/tkounter/node_name 2>/dev/null)',
        'hostname_value=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || echo unknown)',
        'mac_value=$(cat /sys/class/net/br-lan/address 2>/dev/null || cat /sys/class/net/eth0/address 2>/dev/null || echo unknown)',
        'firmware=$(cat /etc/openwrt_release 2>/dev/null | sed -n "s/^DISTRIB_RELEASE=\\"\\(.*\\)\\"$/\\1/p")',
        'if [ -z "$firmware" ]; then firmware="unknown"; fi',
        'if [ -n "$uuid" ]; then state="provisioned"; else state="fresh"; fi',
        'printf "UUID=%s\\nNAME=%s\\nHOSTNAME=%s\\nMAC=%s\\nFIRMWARE=%s\\nSTATE=%s\\n" "$uuid" "$node_name" "$hostname_value" "$mac_value" "$firmware" "$state"'
    ].join('\n')

    const { stdout } = await sshExec({ host, username, password, command })
    const lines = stdout.split('\n').filter(Boolean)
    const output = {}

    for (const line of lines) {
        const idx = line.indexOf('=')
        if (idx <= 0) continue
        output[line.slice(0, idx)] = line.slice(idx + 1)
    }

    // Prefer GL.iNet RPC values when available, especially firmware_version.
    let rpcInfo = null
    try {
        rpcInfo = await probeGlInetRpc(host, DEFAULT_DISCOVERY_RPC_TIMEOUT_MS)
    } catch {
        rpcInfo = null
    }

    const hostname = String(rpcInfo?.hostname || output.HOSTNAME || '').trim() || 'unknown'
    const firmwareVersion = String(rpcInfo?.firmwareVersion || output.FIRMWARE || '').trim() || 'unknown'

    return {
        uuid: output.UUID || '',
        nodeName: String(output.NAME || '').trim(),
        hostname,
        mac: output.MAC || 'unknown',
        firmwareVersion,
        state: output.STATE || 'unknown'
    }
}

async function waitForNodeReboot({ host, username, password, onOutput, maxAttempts = 120, delayMs = 5000, initialDelayMs = 3000 }) {
    let seenDown = false

    if (initialDelayMs > 0) {
        if (typeof onOutput === 'function') {
            onOutput(`Initial wait of ${initialDelayMs}ms before checking reboot...`)
        }
        await new Promise(resolve => setTimeout(resolve, initialDelayMs))
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await sshExec({
                host,
                username,
                password,
                command: 'echo ready',
                timeoutMs: 7000
            })

            if (!seenDown) {
                if (typeof onOutput === 'function') {
                    onOutput(`Reboot not detected yet (SSH still up) attempt ${attempt}/${maxAttempts}`)
                }
            } else {
                if (typeof onOutput === 'function') {
                    onOutput(`Node reachable after reboot (attempt ${attempt})`)
                }
                return true
            }
        } catch (err) {
            if (!seenDown) {
                seenDown = true
                if (typeof onOutput === 'function') {
                    onOutput(`Reboot detected: SSH unreachable (attempt ${attempt}/${maxAttempts})`)
                }
            } else if (typeof onOutput === 'function') {
                onOutput(`Waiting for SSH to come back... attempt ${attempt}/${maxAttempts}`)
            }
        }

        if (attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, delayMs))
        }
    }

    if (!seenDown) {
        throw new Error(`SSH did not go down after reboot within ${maxAttempts} attempts`)
    }
    throw new Error(`Node did not reconnect after ${maxAttempts} attempts`)
}

async function checkServicesRunning({ host, username, password, onOutput }) {
    const command = [
        'tk=$(ps w | grep -w "[t]kounter" | head -n1 || true)',
        'as=$(ps w | grep -w "[a]utossh" | head -n1 || true)',
        'printf "TKOUNTER=%s\\nAUTOSSH=%s\\n" "$tk" "$as"'
    ].join('\n')

    const { stdout } = await sshExec({
        host,
        username,
        password,
        command,
        timeoutMs: 10000
    })

    const hastkounter = /TKOUNTER=.+/.test(stdout)
    const hasAutossh = /AUTOSSH=.+/.test(stdout)

    if (typeof onOutput === 'function') {
        onOutput(`Service status: tkounter=${hastkounter ? 'OK' : 'STOPPED'}, autossh=${hasAutossh ? 'OK' : 'STOPPED'}`)
    }

    if (!hastkounter) {
        throw new Error('tkounter is not running')
    }
    if (!hasAutossh) {
        throw new Error('autossh is not running')
    }

    return { tkounter: hastkounter, autossh: hasAutossh }
}

async function waitForServicesRunning({ host, username, password, onOutput, maxAttempts = 24, delayMs = 5000 }) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const status = await checkServicesRunning({ host, username, password, onOutput })
            if (typeof onOutput === 'function') {
                onOutput(`Services ready after reboot (attempt ${attempt}/${maxAttempts})`)
            }
            return status
        } catch (err) {
            if (typeof onOutput === 'function') {
                onOutput(`Services not ready yet (attempt ${attempt}/${maxAttempts}): ${err.message}`)
            }
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, delayMs))
            }
        }
    }

    throw new Error(`Services unavailable after ${maxAttempts} attempts`)
}

// First half of provisioning: everything that only needs SSH access to the
// node itself, no TKounterManager backend involved. Returns the facts the
// caller (React) needs to register the node against its own backend.
//
// `forceUuid` covers two "re-provision" scenarios (as opposed to a brand new
// node): replacing broken hardware with a new unit that must take over an
// existing node's identity, and rebuilding a corrupted/factory-reset unit
// that lost its own /etc/tkounter/node_uuid but should keep being the same
// node in TKounterManager. In both cases the caller passes the uuid already
// stored in TKounterManager's DB for that node, and this function makes the
// (possibly fresh) filesystem report that uuid instead of generating a new
// one, so `POST /api/nodes-provision` updates the existing DB row (same tid,
// same controllers/sensors/records) instead of creating a new node.
async function prepareNode({ host, name, username, password, forceUuid, onProgress }) {
    const log = (message) => {
        console.log(`[PROVISION] ${message}`)
        if (typeof onProgress === 'function') onProgress(message)
    }

    // Node names are free-form descriptive text (can include spaces and any
    // UTF-8 characters) and may be duplicated across nodes; the actual unique
    // system hostname is derived from it plus a short UUID suffix on the node
    // itself (see buildHostnameScriptInstallCommand). Here we only guard
    // against empty/oversized/control-character input.
    const normalizedName = String(name || '').trim().replace(/\s+/g, ' ')
    if (!normalizedName) {
        throw new Error('Node name is required')
    }
    if (normalizedName.length > 64) {
        throw new Error('Node name is too long (max 64 characters)')
    }
    if (/[\u0000-\u001f\u007f]/.test(normalizedName)) {
        throw new Error('Node name contains invalid control characters')
    }

    const normalizedForceUuid = forceUuid ? String(forceUuid).trim().toLowerCase() : ''
    if (normalizedForceUuid && !NODE_UUID_RE.test(normalizedForceUuid)) {
        throw new Error('forceUuid is not a valid uuid')
    }

    if (normalizedForceUuid) {
        // Written as its own step (before prepare-node.sh, which only generates a
        // uuid when the file is missing) so a re-provisioned/replaced unit adopts
        // the target node's identity instead of getting a brand new one. Value is
        // already validated above and single-quoted regardless, matching how
        // every other externally-supplied value in this file reaches the remote
        // shell (never interpolated unquoted into an executed command).
        log(`Forcing node identity to existing uuid ${normalizedForceUuid}...`)
        await sshExec({
            host,
            username,
            password,
            command: `mkdir -p /etc/tkounter && printf '%s' ${shellSingleQuote(normalizedForceUuid)} > /etc/tkounter/node_uuid`,
            timeoutMs: 10000,
            onOutput: log
        })
    }

    log('Preparing node (UUID, keys, base packages)...')
    const prepScript = readNodeScript('prepare-node.sh')

    await sshExec({ host, username, password, command: prepScript, timeoutMs: 180000, onOutput: log })

    log('Configuring node hostname...')
    await sshExec({
        host,
        username,
        password,
        command: buildHostnameScriptInstallCommand(),
        timeoutMs: 30000,
        onOutput: log
    })
    const { stdout: hostnameOut } = await sshExec({
        host,
        username,
        password,
        command: `/usr/bin/tkounter-hostname.sh ${shellSingleQuote(normalizedName)}`,
        timeoutMs: 20000,
        onOutput: log
    })
    const appliedHostname = hostnameOut.trim().split('\n').filter(Boolean).pop() || ''
    if (appliedHostname) {
        log(`Node hostname set to: ${appliedHostname}`)
    }

    log('Reading node metadata and public keys...')
    const inspect = await inspectNode({ host, username, password })
    const { stdout: keyOut } = await sshExec({
        host,
        username,
        password,
        command: 'printf "REG=%s\\nTUN=%s\\n" "$(cat /root/.ssh/id_ed25519.pub)" "$(cat /root/.ssh/id_ed25519_tunnel.pub)"',
        onOutput: log
    })

    const regMatch = keyOut.match(/^REG=(.*)$/m)
    const tunMatch = keyOut.match(/^TUN=(.*)$/m)
    const regPubKey = regMatch ? regMatch[1].trim() : ''
    const tunPubKey = tunMatch ? tunMatch[1].trim() : ''

    if (!inspect.uuid) {
        throw new Error('Could not get node_uuid from the node')
    }

    if (normalizedForceUuid && inspect.uuid !== normalizedForceUuid) {
        throw new Error('Node did not adopt the forced uuid; aborting to avoid registering it under the wrong identity')
    }

    if (!regPubKey || !tunPubKey) {
        throw new Error('Could not get node public keys')
    }

    log('Node ready for registration.')
    return {
        uuid: inspect.uuid,
        name: normalizedName,
        hostname: appliedHostname || inspect.hostname,
        mac: inspect.mac,
        firmwareVersion: inspect.firmwareVersion,
        regPubKey,
        tunPubKey,
        reprovisioned: Boolean(normalizedForceUuid)
    }
}

// Second half of provisioning: the caller (React) already registered the node
// against its own backend (POST /api/nodes-provision) using the facts from
// prepareNode(), and passes back here whatever that backend returned
// (tunnelPort, serverAdminPublicKey, nodesRuntimeUrl, wsUrl) plus serverName.
// This function never talks to any TKounterManager backend itself.
async function finishProvisioning({
    host,
    username,
    password,
    serverName,
    wsUrl,
    nodesRuntimeUrl,
    tunnelPort,
    serverAdminPublicKey,
    updateChannel,
    onProgress
}) {
    const log = (message) => {
        console.log(`[PROVISION] ${message}`)
        if (typeof onProgress === 'function') onProgress(message)
    }

    const normalizedTunnelPort = Number(tunnelPort)
    if (!Number.isInteger(normalizedTunnelPort) || normalizedTunnelPort <= 0) {
        throw new Error('A valid tunnelPort is required')
    }
    if (!serverName) {
        throw new Error('serverName is required')
    }

    const normalizedNodesRuntimeUrl = normalizeBaseUrl(nodesRuntimeUrl)
    const normalizedWsUrl = normalizeWsUrl(wsUrl)

    let adminKeyInstalled = false
    if (serverAdminPublicKey) {
        log('Installing server admin key for passwordless SSH...')
        const installKeyScript = [
            'set -e',
            'mkdir -p /etc/dropbear',
            'touch /etc/dropbear/authorized_keys',
            'chmod 600 /etc/dropbear/authorized_keys',
            `KEY=${shellSingleQuote(serverAdminPublicKey)}`,
            'grep -qxF "$KEY" /etc/dropbear/authorized_keys || printf "%s\\n" "$KEY" >> /etc/dropbear/authorized_keys'
        ].join('\n')
        await sshExec({ host, username, password, command: installKeyScript, timeoutMs: 20000, onOutput: log })
        adminKeyInstalled = true
        log('Server admin key installed on node.')
    } else {
        log('No server admin key provided, skipping passwordless SSH setup.')
    }

    log('Writing tunnel script and init.d service...')

    // Variables are substituted locally (not via remote `sed`) so a
    // serverName/port never has to be interpolated into a line of shell that
    // the remote node itself would parse.
    const tunnelScript = [
        'set -e',
        'cat > /usr/bin/ssh_tunnel.sh <<"EOT"',
        renderNodeScript('ssh-tunnel.sh', {
            SERVER: escapeForDoubleQuotedShellLiteral(serverName),
            PORT: String(normalizedTunnelPort)
        }),
        'EOT',
        'chmod +x /usr/bin/ssh_tunnel.sh',
        'cat > /etc/init.d/ssh_tunnel <<"EOT"',
        readNodeScript('ssh-tunnel.init'),
        'EOT',
        'chmod +x /etc/init.d/ssh_tunnel',
        '/etc/init.d/ssh_tunnel enable || true',
        '/etc/init.d/ssh_tunnel stop >/dev/null 2>&1 || true',
        '/etc/init.d/ssh_tunnel start || true'
    ].join('\n')

    await sshExec({ host, username, password, command: tunnelScript, timeoutMs: 90000, onOutput: log })

    log('Installing bootstrap/config and tkounter binary...')

    // 'stable' matches TKounterNode's own bootstrap default; the backend is
    // the one deciding 'dev' vs 'stable' per its own UPDATE_CHANNEL env var
    // (see TKounterManager POST /api/nodes-provision), never guessed here.
    const bootstrapContent = renderNodeScript('bootstrap.json.tmpl', {
        NODES_RUNTIME_URL: escapeForJsonLiteral(normalizedNodesRuntimeUrl),
        WS_URL: escapeForJsonLiteral(normalizedWsUrl),
        UPDATES_BASE_URL: escapeForJsonLiteral(UPDATES_BASE_URL),
        UPDATES_APP: escapeForJsonLiteral(UPDATES_APP),
        UPDATES_FLAVOR: escapeForJsonLiteral(UPDATES_FLAVOR),
        UPDATE_CHANNEL: escapeForJsonLiteral(updateChannel || 'stable')
    })

    const installScript = [
        'set -e',
        `UPDATES_BASE_URL="${UPDATES_BASE_URL}"`,
        `UPDATES_APP="${UPDATES_APP}"`,
        `UPDATES_FLAVOR="${UPDATES_FLAVOR}"`,
        'mkdir -p /etc/tkounter /overlay/tkounter /tmp/tkounter-update',
        '[ -f /etc/tkounter/bootstrap.json ] || cat > /etc/tkounter/bootstrap.json <<"EOT"',
        bootstrapContent,
        'EOT',
        '[ -f /etc/tkounter/config.json ] || cat > /etc/tkounter/config.json <<"EOT"',
        readNodeScript('config.json'),
        'EOT',
        readNodeScript('install-tkounter-binary.sh'),
        'cat > /etc/init.d/tkounter <<"EOT"',
        readNodeScript('tkounter.init'),
        'EOT',
        'chmod +x /etc/init.d/tkounter',
        '/etc/init.d/tkounter enable || true',
        '/etc/init.d/tkounter stop >/dev/null 2>&1 || true',
        '/etc/init.d/tkounter start || true',
        'rm -rf /tmp/tkounter-update'
    ].join('\n')

    await sshExec({ host, username, password, command: installScript, timeoutMs: 240000, onOutput: log })

    log('Rebooting node...')
    await sshExec({
        host,
        username,
        password,
        command: 'sync; sh -c "(sleep 1; reboot) >/dev/null 2>&1 &"',
        timeoutMs: 15000,
        onOutput: log
    })

    log('Waiting for node reboot...')
    await waitForNodeReboot({ host, username, password, onOutput: log })

    log('Checking services on node...')
    await waitForServicesRunning({ host, username, password, onOutput: log })

    log('Provisioning completed successfully.')
    return {
        tunnelPort: normalizedTunnelPort,
        defaultSshAccess: `ssh root@localhost -p ${normalizedTunnelPort}`,
        adminKeyInstalled,
        state: 'ok'
    }
}

module.exports = {
    discoverNodes,
    inspectNode,
    prepareNode,
    finishProvisioning
}
