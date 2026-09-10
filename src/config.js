const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const CONFIG_DIR = process.env.TKOUNTER_PROVISION_HOME || path.join(os.homedir(), '.tkounter-node-provision')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

// This service never talks to the TKounterManager backend itself (React does,
// with its own session token) - it only executes LAN discovery/SSH orders on
// React's behalf. So the only thing left to configure locally is which pages
// are allowed to drive it at all (CORS), not which backend to call.
const BUILTIN_ORIGINS = ['https://techkovery.eu', 'https://www.techkovery.eu', 'https://dev.techkovery.eu']

const DEFAULTS = {
    // Extra origins an operator can add (e.g. their office's TKounterManager
    // instance served from a LAN IP) on top of BUILTIN_ORIGINS, via PUT /config.
    customOrigins: [],
    pairingToken: null
}

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

    if (Array.isArray(patch.customOrigins)) {
        next.customOrigins = patch.customOrigins.filter((origin) => typeof origin === 'string' && origin)
    }

    persist(next)
    cached = next
    return cached
}

function isOriginAllowed(origin) {
    if (BUILTIN_ORIGINS.includes(origin)) return true
    return get().customOrigins.includes(origin)
}

module.exports = { load, get, update, isOriginAllowed, BUILTIN_ORIGINS, CONFIG_FILE }


