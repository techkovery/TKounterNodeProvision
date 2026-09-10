const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const CONFIG_DIR = process.env.TKOUNTER_PROVISION_HOME || path.join(os.homedir(), '.tkounter-node-provision')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

const DEFAULTS = {
    apiBaseUrl: 'https://techkovery.eu',
    wsUrl: 'ws://nodes.techkovery.eu/ws',
    nodesRuntimeUrl: 'https://nodes.techkovery.eu',
    serverName: 'techkovery.eu',
    allowedOrigins: ['https://techkovery.eu'],
    pairingToken: null
}

// Fields the local HTTP API is allowed to read/write via GET|PUT /config.
// pairingToken is deliberately excluded: it is only generated/read locally.
const PUBLIC_FIELDS = ['apiBaseUrl', 'wsUrl', 'nodesRuntimeUrl', 'serverName', 'allowedOrigins']

let cached = null

function persist(data) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
    fs.chmodSync(CONFIG_FILE, 0o600)
}

// Loads the local config once per process, generating the one-time pairing
// token on first run. The operator copies that token into the React modal so
// the browser is authorized to call this service afterwards.
function load() {
    if (cached) return cached

    let stored = {}
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
        } catch {
            stored = {}
        }
    }

    const merged = { ...DEFAULTS, ...stored }
    if (!merged.pairingToken) {
        merged.pairingToken = crypto.randomBytes(24).toString('hex')
    }

    persist(merged)
    cached = merged
    return cached
}

function get() {
    return cached || load()
}

function update(patch = {}) {
    const current = get()
    const next = { ...current }
    for (const key of PUBLIC_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
            next[key] = patch[key]
        }
    }
    persist(next)
    cached = next
    return cached
}

module.exports = { load, get, update, CONFIG_FILE }
