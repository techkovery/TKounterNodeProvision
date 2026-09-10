const express = require('express')
const cors = require('cors')
const pkg = require('../package.json')
const config = require('./config')
const jobs = require('./jobs')
const { requireAuth } = require('./auth')
const { discoverNodes, inspectNode, prepareNode, finishProvisioning } = require('./provisioning')

const cfg = config.load()

if (process.argv.includes('--show-token')) {
    console.log(cfg.pairingToken)
    process.exit(0)
}

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i

// This service only executes LAN discovery/SSH orders for whichever page is
// driving it - it never calls the TKounterManager backend itself, so CORS
// here is just "which pages may drive it", not a credential-leak boundary.
function isOriginAllowed(origin) {
    if (!origin) return true // same-machine tools (curl, health checks) send no Origin header
    if (LOCALHOST_ORIGIN.test(origin)) return true
    return config.isOriginAllowed(origin)
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

app.get('/config', (req, res) => {
    const { customOrigins } = config.get()
    res.json({ builtinOrigins: config.BUILTIN_ORIGINS, customOrigins })
})

app.put('/config', (req, res) => {
    const { customOrigins } = config.update(req.body)
    res.json({ builtinOrigins: config.BUILTIN_ORIGINS, customOrigins })
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

// Both /prepare and /finish run in the background and are tracked the same
// way via jobId (snapshot polling on GET /jobs/:jobId or live updates via
// GET /jobs/:jobId/stream). Neither step calls the TKounterManager backend:
// React does that in between, using the facts prepareNode() returns to call
// its own backend, then passes whatever the backend replied with to /finish.
app.post('/prepare', (req, res) => {
    const { host, name, username, password } = req.body || {}
    if (!host || !name || !username) {
        return res.status(400).json({ error: 'host, name and username are required' })
    }

    const job = jobs.createJob()
    prepareNode({
        host,
        name,
        username,
        password,
        onProgress: (message) => jobs.appendLog(job, message)
    }).then((result) => jobs.finish(job, result)).catch((err) => jobs.fail(job, err))

    res.status(202).json({ jobId: job.id })
})

app.post('/finish', (req, res) => {
    const { host, username, password, serverName, wsUrl, nodesRuntimeUrl, tunnelPort, serverAdminPublicKey } = req.body || {}
    if (!host || !username || !serverName || !wsUrl || !nodesRuntimeUrl || !tunnelPort) {
        return res.status(400).json({ error: 'host, username, serverName, wsUrl, nodesRuntimeUrl and tunnelPort are required' })
    }

    const job = jobs.createJob()
    finishProvisioning({
        host,
        username,
        password,
        serverName,
        wsUrl,
        nodesRuntimeUrl,
        tunnelPort,
        serverAdminPublicKey,
        onProgress: (message) => jobs.appendLog(job, message)
    }).then((result) => jobs.finish(job, result)).catch((err) => jobs.fail(job, err))

    res.status(202).json({ jobId: job.id })
})

app.get('/jobs/:jobId', (req, res) => {
    const job = jobs.getJob(req.params.jobId)
    if (!job) return res.status(404).json({ error: 'job_not_found' })
    res.json({ status: job.status, logs: job.logs, result: job.result, error: job.error })
})

app.get('/jobs/:jobId/stream', (req, res) => {
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
