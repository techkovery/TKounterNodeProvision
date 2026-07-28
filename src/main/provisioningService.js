const os = require('os')
const net = require('net')
const axios = require('axios')
const { Client } = require('ssh2')

const DEFAULT_DISCOVERY_TIMEOUT_MS = 350
const DEFAULT_DISCOVERY_PORT = 22
const DEFAULT_DISCOVERY_HTTP_PORT = 80
const DEFAULT_DISCOVERY_RPC_TIMEOUT_MS = 1500
const DEFAULT_PORT_BASE = 20000
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
        '#!/bin/sh',
        '# Unified hostname/name script: writes /etc/tkounter/node_name and applies',
        '# the derived system hostname (tk-<slug>-<uuid6>). Called during initial',
        '# provisioning and can be invoked again later (e.g. by the tkounter binary)',
        '# whenever the node name changes from the backend, keeping the SSH hostname',
        '# in sync. Usage: tkounter-hostname.sh ["new node name"]',
        'set -e',
        'NODE_NAME="$1"',
        'NAME_FILE="/etc/tkounter/node_name"',
        'UUID_FILE="/etc/tkounter/node_uuid"',
        '[ -n "$NODE_NAME" ] || { [ -f "$NAME_FILE" ] && NODE_NAME=$(cat "$NAME_FILE"); }',
        '[ -n "$NODE_NAME" ] || { echo "Usage: $0 <node_name>" >&2; exit 1; }',
        '[ -f "$UUID_FILE" ] || { echo "Missing $UUID_FILE" >&2; exit 1; }',
        'NODE_UUID=$(cat "$UUID_FILE")',
        'SHORT_UUID=$(printf "%s" "$NODE_UUID" | tr -d "-" | tr "A-Z" "a-z" | cut -c1-6)',
        '[ -n "$SHORT_UUID" ] || { echo "Invalid node_uuid" >&2; exit 1; }',
        'slugify() {',
        '  printf "%s" "$1" \\',
        '    | sed -e "s/á/a/g" -e "s/à/a/g" -e "s/ä/a/g" -e "s/â/a/g" -e "s/ã/a/g" \\',
        '          -e "s/é/e/g" -e "s/è/e/g" -e "s/ë/e/g" -e "s/ê/e/g" \\',
        '          -e "s/í/i/g" -e "s/ì/i/g" -e "s/ï/i/g" -e "s/î/i/g" \\',
        '          -e "s/ó/o/g" -e "s/ò/o/g" -e "s/ö/o/g" -e "s/ô/o/g" -e "s/õ/o/g" \\',
        '          -e "s/ú/u/g" -e "s/ù/u/g" -e "s/ü/u/g" -e "s/û/u/g" \\',
        '          -e "s/ñ/n/g" -e "s/ç/c/g" \\',
        '          -e "s/Á/A/g" -e "s/À/A/g" -e "s/Ä/A/g" -e "s/Â/A/g" -e "s/Ã/A/g" \\',
        '          -e "s/É/E/g" -e "s/È/E/g" -e "s/Ë/E/g" -e "s/Ê/E/g" \\',
        '          -e "s/Í/I/g" -e "s/Ì/I/g" -e "s/Ï/I/g" -e "s/Î/I/g" \\',
        '          -e "s/Ó/O/g" -e "s/Ò/O/g" -e "s/Ö/O/g" -e "s/Ô/O/g" -e "s/Õ/O/g" \\',
        '          -e "s/Ú/U/g" -e "s/Ù/U/g" -e "s/Ü/U/g" -e "s/Û/U/g" \\',
        '          -e "s/Ñ/N/g" -e "s/Ç/C/g" \\',
        '    | tr "A-Z" "a-z" \\',
        '    | sed -r "s/[^a-z0-9]+/-/g; s/^-+//; s/-+\\$//"',
        '}',
        'LABEL=$(slugify "$NODE_NAME")',
        '[ -n "$LABEL" ] || LABEL="node"',
        'MAX_LABEL_LEN=53',
        'LABEL=$(printf "%s" "$LABEL" | cut -c1-"$MAX_LABEL_LEN" | sed -r "s/-+\\$//")',
        '[ -n "$LABEL" ] || LABEL="node"',
        'NEW_HOSTNAME="tk-${LABEL}-${SHORT_UUID}"',
        'printf "%s" "$NODE_NAME" > "$NAME_FILE"',
        'if command -v uci >/dev/null 2>&1; then',
        '  uci set system.@system[0].hostname="$NEW_HOSTNAME"',
        '  uci commit system',
        'fi',
        'echo "$NEW_HOSTNAME" > /proc/sys/kernel/hostname 2>/dev/null || true',
        'sed -i "/# tkounter-hostname/d" /etc/hosts 2>/dev/null || true',
        'printf "127.0.0.1\\t%s # tkounter-hostname\\n" "$NEW_HOSTNAME" >> /etc/hosts 2>/dev/null || true',
        '[ -x /etc/init.d/system ] && /etc/init.d/system reload >/dev/null 2>&1 || true',
        '# Regenerate the SSH login banner so it always reflects the current name,',
        '# uuid and hostname instead of hardcoding them (this block re-runs every',
        '# time this script runs, i.e. on provisioning and on later rename events).',
        'BANNER_FILE="/etc/banner"',
        'cat > "$BANNER_FILE" <<"EOB"',
        '-----------------------------------------------------',
        ' _____ _  __                 _',
        '|_   _| |/ /___  _   _ _ __ | |_ ___ _ __',
        "  | | | ' // _ \\| | | | '_ \\| __/ _ \\ '__|",
        '  | | | . \\ (_) | |_| | | | | ||  __/ |',
        '  |_| |_|\\_\\___/ \\__,_|_| |_|\\__\\___|_|',
        '',
        '-----------------------------------------------------',
        'TechKovery TKounter Node',
        '',
        'EOB',
        'printf "Name: %s\\nUUID: %s\\nHost: %s\\n" "$NODE_NAME" "$NODE_UUID" "$NEW_HOSTNAME" >> "$BANNER_FILE"',
        'printf -- "-----------------------------------------------------\\n" >> "$BANNER_FILE"',
        'if command -v uci >/dev/null 2>&1 && [ -f /etc/config/dropbear ]; then',
        '  uci set dropbear.@dropbear[0].BannerFile="$BANNER_FILE" 2>/dev/null || true',
        '  uci commit dropbear 2>/dev/null || true',
        'fi',
        'echo "$NEW_HOSTNAME"',
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

async function callProvisionEndpoint({ apiBaseUrl, token, nodeUuid, name, mac, hostname, firmwareVersion, regPubKey, tunPubKey }) {
    const url = `${normalizeBaseUrl(apiBaseUrl)}/api/nodes-provision`
    const response = await axios.post(url, {
        uuid: nodeUuid,
        name,
        mac,
        hostname,
        firmwareVersion,
        regPubKey,
        tunPubKey
    }, {
        headers: { 'x-access-token': token },
        timeout: 30000
    })

    return response.data
}

async function authLogin({ apiBaseUrl, username, password }) {
    const url = `${normalizeBaseUrl(apiBaseUrl)}/api/auth/signin`
    const response = await axios.post(url, {
        userName: username,
        password
    }, {
        timeout: 15000
    })

    if (!response.data?.token) {
        throw new Error('Server did not return an authentication token')
    }

    return response.data
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

async function runProvisioning({
    host,
    name,
    username,
    password,
    apiBaseUrl,
    wsUrl,
    nodesRuntimeUrl,
    token,
    serverName,
    onProgress
}) {
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

    const normalizedNodesRuntimeUrl = normalizeBaseUrl(nodesRuntimeUrl)
    const normalizedWsUrl = normalizeWsUrl(wsUrl)

    log('Preparing node (UUID, keys, base packages)...')
    const prepScript = [
        'set -e',
        'generate_uuid_v4() {',
        '  if [ -r /proc/sys/kernel/random/uuid ]; then cat /proc/sys/kernel/random/uuid; return; fi',
        '  if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr "A-Z" "a-z"; return; fi',
        '  od -An -N16 -tx1 /dev/urandom | tr -d " \\n" | sed -E "s/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/\\1-\\2-\\3-\\4-\\5/"',
        '}',
        'need_opkg_update=0',
        'for p in autossh ca-bundle libstdcpp; do opkg list-installed | grep -q "^$p" || need_opkg_update=1; done',
        'if [ "$need_opkg_update" -eq 1 ]; then',
        '  opkg update',
        '  opkg list-installed | grep -q "^autossh" || opkg install autossh',
        '  opkg list-installed | grep -q "^ca-bundle" || opkg install ca-bundle',
        '  opkg list-installed | grep -q "^libstdcpp" || opkg install libstdcpp',
        'fi',
        'mkdir -p /etc/tkounter /root/.ssh',
        'chmod 700 /root/.ssh',
        '[ -f /etc/tkounter/node_uuid ] || generate_uuid_v4 > /etc/tkounter/node_uuid',
        '[ -f /root/.ssh/id_ed25519 ] || dropbearkey -t ed25519 -f /root/.ssh/id_ed25519',
        'dropbearkey -y -f /root/.ssh/id_ed25519 | grep "^ssh-ed25519" > /root/.ssh/id_ed25519.pub',
        '[ -f /root/.ssh/id_ed25519_tunnel ] || dropbearkey -t ed25519 -f /root/.ssh/id_ed25519_tunnel',
        'dropbearkey -y -f /root/.ssh/id_ed25519_tunnel | grep "^ssh-ed25519" > /root/.ssh/id_ed25519_tunnel.pub'
    ].join('\n')

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

    if (!regPubKey || !tunPubKey) {
        throw new Error('Could not get node public keys')
    }

    log(`Registering node ${inspect.uuid} in backend...`)
    const provisionResponse = await callProvisionEndpoint({
        apiBaseUrl,
        token,
        nodeUuid: inspect.uuid,
        name: normalizedName,
        mac: inspect.mac,
        hostname: inspect.hostname,
        firmwareVersion: inspect.firmwareVersion,
        regPubKey,
        tunPubKey
    })

    const tunnelPort = Number(provisionResponse.port || provisionResponse.tunnelPort || provisionResponse.sshPort || 0)
    if (!Number.isInteger(tunnelPort) || tunnelPort <= 0) {
        throw new Error('Backend did not return a valid tunnel_port')
    }

    log(`Assigned tunnel port: ${tunnelPort}`)
    log('Writing tunnel script and init.d service...')

    const tunnelScript = [
        'set -e',
        `SERVER_NAME="${serverName}"`,
        `PORT="${tunnelPort}"`,
        'cat > /usr/bin/ssh_tunnel.sh <<"EOT"',
        '#!/bin/sh',
        'SERVER="__SERVER__"',
        'USER="tunnel"',
        'KEY="/root/.ssh/id_ed25519_tunnel"',
        'PORT="__PORT__"',
        '# Disable autossh gatetime check: without this, if the inner ssh dies twice',
        '# before 30s (e.g. network interface not up yet at boot), autossh gives up',
        '# permanently instead of retrying.',
        'export AUTOSSH_GATETIME=0',
        'exec /usr/sbin/autossh -M 0 -N -y \\',
        '  -o ServerAliveInterval=30 \\',
        '  -o ServerAliveCountMax=3 \\',
        '  -o ConnectTimeout=10 \\',
        '  -o ExitOnForwardFailure=yes \\',
        '  -i "$KEY" \\',
        '  -R 127.0.0.1:${PORT}:localhost:22 \\',
        '  ${USER}@${SERVER}',
        'EOT',
        'sed -i "s/__SERVER__/$SERVER_NAME/" /usr/bin/ssh_tunnel.sh',
        'sed -i "s/__PORT__/$PORT/" /usr/bin/ssh_tunnel.sh',
        'chmod +x /usr/bin/ssh_tunnel.sh',
        'cat > /etc/init.d/ssh_tunnel <<"EOT"',
        '#!/bin/sh /etc/rc.common',
        'START=95',
        'USE_PROCD=1',
        'start_service() {',
        '  procd_open_instance',
        '  procd_set_param command /usr/bin/ssh_tunnel.sh',
        '  procd_set_param respawn 3600 5 0',
        '  procd_close_instance',
        '}',
        'EOT',
        'chmod +x /etc/init.d/ssh_tunnel',
        '/etc/init.d/ssh_tunnel enable || true',
        '/etc/init.d/ssh_tunnel stop >/dev/null 2>&1 || true',
        '/etc/init.d/ssh_tunnel start || true'
    ].join('\n')

    await sshExec({ host, username, password, command: tunnelScript, timeoutMs: 90000, onOutput: log })

    log('Installing bootstrap/config and tkounter binary...')
    const installScript = [
        'set -e',
        `NODES_RUNTIME_URL="${normalizedNodesRuntimeUrl}"`,
        `WS_URL="${normalizedWsUrl}"`,
        `UPDATES_BASE_URL="${UPDATES_BASE_URL}"`,
        `UPDATES_APP="${UPDATES_APP}"`,
        `UPDATES_FLAVOR="${UPDATES_FLAVOR}"`,
        'mkdir -p /etc/tkounter /overlay/tkounter /tmp/tkounter-update',
        '[ -f /etc/tkounter/bootstrap.json ] || cat > /etc/tkounter/bootstrap.json <<"EOT"',
        '{',
        '  "network": { "server_url": "__NODES_RUNTIME_URL__", "ws_url": "__WS_URL__", "timeout_sec": 5, "ws_enabled": true },',
        '  "paths": { "node_uuid": "/etc/tkounter/node_uuid", "state": "/etc/tkounter/state.json", "runtime_config": "/etc/tkounter/config.json" },',
        '  "update": { "enabled": true, "base_url": "__UPDATES_BASE_URL__", "app": "__UPDATES_APP__", "flavor": "__UPDATES_FLAVOR__", "channel": "stable", "check_interval_sec": 300, "jitter_sec": 30, "base_dir": "/overlay/tkounter", "allow_downgrade": false }',
        '}',
        'EOT',
        'sed -i "s|__NODES_RUNTIME_URL__|$NODES_RUNTIME_URL|g" /etc/tkounter/bootstrap.json',
        'sed -i "s|__WS_URL__|$WS_URL|g" /etc/tkounter/bootstrap.json',
        'sed -i "s|__UPDATES_BASE_URL__|$UPDATES_BASE_URL|g" /etc/tkounter/bootstrap.json',
        'sed -i "s|__UPDATES_APP__|$UPDATES_APP|g" /etc/tkounter/bootstrap.json',
        'sed -i "s|__UPDATES_FLAVOR__|$UPDATES_FLAVOR|g" /etc/tkounter/bootstrap.json',
        '[ -f /etc/tkounter/config.json ] || cat > /etc/tkounter/config.json <<"EOT"',
        '{ "runtime": { "interval_seconds": 300, "log": { "path": "/tmp/tkounter.log", "max_size_kb": 512, "level": "info" }, "queue": { "path": "/tmp/tkounter.queue", "max_size_kb": 512 } }, "devices": [] }',
        'EOT',
        'download_to_file() {',
        '  url="$1"; out="$2"',
        '  if command -v uclient-fetch >/dev/null 2>&1; then uclient-fetch -q -O "$out" "$url"; else wget -q -O "$out" "$url"; fi',
        '}',
        'MANIFEST_FILE="/tmp/tkounter-update/manifest.json"',
        'ARTIFACT_FILE="/tmp/tkounter-update/update.tar.gz"',
        'EXTRACT_DIR="/tmp/tkounter-update/extract"',
        'download_to_file "$UPDATES_BASE_URL/updates/$UPDATES_APP/$UPDATES_FLAVOR/manifest" "$MANIFEST_FILE"',
        'if command -v jsonfilter >/dev/null 2>&1; then DOWNLOAD_URL="$(jsonfilter -i "$MANIFEST_FILE" -e "@.artifact.download_url")"; else DOWNLOAD_URL="$(sed -n \"s/.*\\\"download_url\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p\" "$MANIFEST_FILE" | head -n1)"; fi',
        '[ -n "$DOWNLOAD_URL" ] || { echo "Missing download_url"; exit 1; }',
        'download_to_file "$DOWNLOAD_URL" "$ARTIFACT_FILE"',
        'rm -rf "$EXTRACT_DIR" && mkdir -p "$EXTRACT_DIR"',
        'tar -xzf "$ARTIFACT_FILE" -C "$EXTRACT_DIR"',
        '[ -f "$EXTRACT_DIR/tkounter" ] || { echo "Missing tkounter binary in artifact"; exit 1; }',
        'cp "$EXTRACT_DIR/tkounter" /overlay/tkounter/tkounter',
        'chmod 0755 /overlay/tkounter/tkounter',
        'cat > /etc/init.d/tkounter <<"EOT"',
        '#!/bin/sh /etc/rc.common',
        'START=96',
        'STOP=10',
        'USE_PROCD=1',
        'BASE_DIR="/overlay/tkounter"',
        'APP_BIN="$BASE_DIR/tkounter"',
        'BOOTSTRAP_FILE="/etc/tkounter/bootstrap.json"',
        'start_service() {',
        '  [ -x "$APP_BIN" ] || return 1',
        '  procd_open_instance',
        '  procd_set_param command "$APP_BIN"',
        '  procd_set_param env TKOUNTER_BOOTSTRAP="$BOOTSTRAP_FILE"',
        '  procd_set_param respawn 3600 5 5',
        '  procd_set_param stdout 1',
        '  procd_set_param stderr 1',
        '  procd_close_instance',
        '}',
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
        nodeUuid: inspect.uuid,
        hostname: appliedHostname || inspect.hostname,
        tunnelPort,
        defaultSshAccess: `ssh root@localhost -p ${tunnelPort}`,
        state: 'ok'
    }
}

module.exports = {
    DEFAULT_PORT_BASE,
    discoverNodes,
    inspectNode,
    authLogin,
    runProvisioning,
    waitForNodeReboot,
    checkServicesRunning,
    waitForServicesRunning
}
