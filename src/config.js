const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const CONFIG_DIR = process.env.TKOUNTER_PROVISION_HOME || path.join(os.homedir(), '.tkounter-node-provision')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

// Known TKounterManager deployments this service is allowed to provision
// nodes against. "origins" are matched against the request's Origin header
// to auto-detect which one is calling (prod/dev share the same physical
// server for the SSH tunnel, only the manager/nodes-runtime vhosts differ,
// see TKounterManager/deploy/nginx/{techkovery,dev.techkovery}.conf).
// Operators can add their own entries (e.g. a "local" one for a LAN dev
// build) via PUT /config without touching these defaults.
const DEFAULTS = {
    environments: {
        prod: {
            origins: ['https://techkovery.eu', 'https://www.techkovery.eu'],
            apiBaseUrl: 'https://techkovery.eu',
            wsUrl: 'ws://nodes.techkovery.eu/ws',
            nodesRuntimeUrl: 'https://nodes.techkovery.eu',
            serverName: 'techkovery.eu'
        },
        dev: {
            origins: ['https://dev.techkovery.eu'],
            apiBaseUrl: 'https://dev.techkovery.eu',
            wsUrl: 'ws://nodes-dev.techkovery.eu/ws',
            nodesRuntimeUrl: 'https://nodes-dev.techkovery.eu',
            serverName: 'techkovery.eu'
        },
        // Unlike prod/dev, there's no fixed hostname: each office runs its own
        // TKounterManager instance on a LAN IP. Starts empty and is meant to
        // be filled in once via PUT /config (the React wizard's "Editar" form).
        local: {
            origins: [],
            apiBaseUrl: '',
            wsUrl: '',
            nodesRuntimeUrl: '',
            serverName: ''
        }
    },
    // Used when a request has no Origin header (e.g. manual curl testing)
    // and no explicit "environment" was given in the body.
    defaultEnvironment: 'prod',
    pairingToken: null
}

// prod/dev point at the real TKounterManager infra and must not be
// repointed via the HTTP API; only custom entries (e.g. "local") are editable.
const RESERVED_ENVIRONMENT_KEYS = ['prod', 'dev']

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

    const merged = { ...DEFAULTS, ...stored, environments: { ...DEFAULTS.environments, ...stored.environments } }
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

// Merges each incoming environment onto its current values (so editing e.g.
// "local" only requires sending the changed fields) and auto-derives
// "origins" from apiBaseUrl when not given explicitly, since in practice the
// SPA is served from the same origin as the API it talks to.
function update(patch = {}) {
    const current = get()
    const next = { ...current }

    if (patch.environments && typeof patch.environments === 'object') {
        next.environments = { ...current.environments }
        for (const [key, patchedEnv] of Object.entries(patch.environments)) {
            if (RESERVED_ENVIRONMENT_KEYS.includes(key)) continue
            const merged = { ...(current.environments[key] || {}), ...patchedEnv }
            if (!patchedEnv.origins && merged.apiBaseUrl) {
                try {
                    merged.origins = [new URL(merged.apiBaseUrl).origin]
                } catch {
                    merged.origins = []
                }
            }
            next.environments[key] = merged
        }
    }

    if (typeof patch.defaultEnvironment === 'string') {
        next.defaultEnvironment = patch.defaultEnvironment
    }
    persist(next)
    cached = next
    return cached
}

// Resolves which deployment (apiBaseUrl/wsUrl/nodesRuntimeUrl/serverName) to
// provision against. Never trusts raw URLs from the caller: only a known
// environment key (explicitKey) or the verified request Origin can select
// one, so a compromised/malicious page cannot redirect the admin bearer
// token to an attacker-controlled apiBaseUrl.
function resolveEnvironment(origin, explicitKey) {
    const environments = get().environments || {}

    if (explicitKey) {
        const env = environments[explicitKey]
        if (!env) {
            const error = new Error(`unknown_environment:${explicitKey}`)
            throw error
        }
        return { key: explicitKey, ...env }
    }

    if (origin) {
        for (const [key, env] of Object.entries(environments)) {
            if ((env.origins || []).includes(origin)) {
                return { key, ...env }
            }
        }
    }

    const fallbackKey = get().defaultEnvironment
    const fallback = environments[fallbackKey]
    if (fallback) {
        return { key: fallbackKey, ...fallback }
    }

    throw new Error('environment_not_resolved')
}

module.exports = { load, get, update, resolveEnvironment, CONFIG_FILE }

