const express = require('express')
const cors = require('cors')
const pkg = require('../package.json')
const config = require('./config')
const jobs = require('./jobs')
const { requireAuth } = require('./auth')
const { discoverNodes, inspectNode, runProvisioning } = require('./provisioning')

const cfg = config.load()

if (process.argv.includes('--show-token')) {
    console.log(cfg.pairingToken)
    process.exit(0)
}

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i

// An origin is allowed to call this service if it belongs to one of the
// configured environments (prod/dev/...) or is a local dev build (vite etc.);
// anything else (a random webpage) is rejected by the browser via CORS.
function isOriginAllowed(origin) {
    if (!origin) return true // same-machine tools (curl, health checks) send no Origin header
    if (LOCALHOST_ORIGIN.test(origin)) return true
    const environments = config.get().environments || {}
    return Object.values(environments).some((env) => (env.origins || []).includes(origin))
}

const app = express()
app.use(express.json({ limit: '256kb' }))
app.use(cors({
    origin(origin, callback) {
        if (isOriginAllowed(origin)) return callback(null, true)
        return callback(new Error('origin_not_allowed'))
    },
    methods: ['GET', 'POST', 'PUT'],
    allowedHeaders: ['Content-Type', 'Authorization']
}))

// Public: lets the React client detect "service installed & reachable"
// without leaking anything sensitive and without requiring the pairing token.
app.get('/health', (req, res) => {
    res.json({ ok: true, name: pkg.name, version: pkg.version })
})

app.use(requireAuth)

// Lets the wizard show which deployment it will provision against before the
// operator confirms ("detected" is what /provision would resolve for this
// same request, i.e. driven by the caller's own Origin header).
app.get('/config', (req, res) => {
    const { environments, defaultEnvironment } = config.get()
    let detected = null
    try {
        detected = config.resolveEnvironment(req.headers.origin).key
    } catch {
        detected = null
    }
    res.json({ environments, defaultEnvironment, detected })
})

app.put('/config', (req, res) => {
    const { environments, defaultEnvironment } = config.update(req.body)
    res.json({ environments, defaultEnvironment })
})

app.post('/discover', async (req, res) => {
    try {
        const hosts = await discoverNodes(req.body || {})
        res.json({ hosts })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.post('/inspect', async (req, res) => {
    const { host, username, password } = req.body || {}
    if (!host || !username) {
        return res.status(400).json({ error: 'host and username are required' })
    }

    try {
        const result = await inspectNode({ host, username, password })
        res.json(result)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// Provisioning runs in the background; the client tracks it via jobId
// (snapshot polling on GET /provision/:jobId or live updates via SSE).
//
// The target deployment (apiBaseUrl/wsUrl/nodesRuntimeUrl/serverName) is
// NEVER taken from the request body: it is resolved server-side from the
// caller's Origin header (or an explicit "environment" key, validated
// against the configured list). Trusting client-supplied URLs here would let
// a compromised page redirect the admin bearer token to an attacker host.
app.post('/provision', (req, res) => {
    const { host, name, username, password, token, environment } = req.body || {}
    if (!host || !name || !username || !token) {
        return res.status(400).json({ error: 'host, name, username and token are required' })
    }

    let env
    try {
        env = config.resolveEnvironment(req.headers.origin, environment)
    } catch (err) {
        return res.status(400).json({ error: err.message })
    }

    const job = jobs.createJob()

    runProvisioning({
        host,
        name,
        username,
        password,
        token,
        apiBaseUrl: env.apiBaseUrl,
        wsUrl: env.wsUrl,
        nodesRuntimeUrl: env.nodesRuntimeUrl,
        serverName: env.serverName,
        onProgress: (message) => jobs.appendLog(job, message)
    }).then((result) => jobs.finish(job, result)).catch((err) => jobs.fail(job, err))

    res.status(202).json({ jobId: job.id, environment: env.key })
})

app.get('/provision/:jobId', (req, res) => {
    const job = jobs.getJob(req.params.jobId)
    if (!job) return res.status(404).json({ error: 'job_not_found' })
    res.json({ status: job.status, logs: job.logs, result: job.result, error: job.error })
})

app.get('/provision/:jobId/stream', (req, res) => {
    const job = jobs.getJob(req.params.jobId)
    if (!job) return res.status(404).json({ error: 'job_not_found' })

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    })

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

    job.logs.forEach((message) => send('log', { message }))
    if (job.status !== 'running') {
        send('done', { status: job.status, result: job.result, error: job.error })
        return res.end()
    }

    const onLog = (message) => send('log', { message })
    const onDone = () => {
        send('done', { status: job.status, result: job.result, error: job.error })
        res.end()
    }

    job.emitter.on('log', onLog)
    job.emitter.on('done', onDone)
    req.on('close', () => {
        job.emitter.off('log', onLog)
        job.emitter.off('done', onDone)
    })
})

app.use((err, req, res, next) => {
    if (err && err.message === 'origin_not_allowed') {
        return res.status(403).json({ error: 'origin_not_allowed' })
    }
    console.error(err)
    res.status(500).json({ error: 'internal_error' })
})

// Bound to loopback only: this service must never be reachable from the LAN,
// just from the browser running on the same office machine.
const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT) || 4783

app.listen(PORT, HOST, () => {
    console.log(`TKounter Node Provision service listening on http://${HOST}:${PORT}`)
    console.log(`Config dir: ${config.CONFIG_FILE}`)
    console.log(`Pairing token (paste it once in the TKounterManager node wizard): ${cfg.pairingToken}`)
})
