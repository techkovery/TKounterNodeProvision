const crypto = require('crypto')
const { EventEmitter } = require('events')

const JOB_TTL_MS = 60 * 60 * 1000
const MAX_FINISHED_JOBS = 50

const jobs = new Map()

function createJob() {
    const job = {
        id: crypto.randomUUID(),
        status: 'running',
        logs: [],
        result: null,
        error: null,
        createdAt: Date.now(),
        emitter: new EventEmitter()
    }
    jobs.set(job.id, job)
    cleanup()
    return job
}

function appendLog(job, message) {
    job.logs.push(message)
    job.emitter.emit('log', message)
}

function finish(job, result) {
    job.status = 'done'
    job.result = result
    job.emitter.emit('done')
}

function fail(job, err) {
    job.status = 'error'
    job.error = err && err.message ? err.message : String(err)
    job.emitter.emit('done')
}

function getJob(id) {
    return jobs.get(id)
}

// Drops finished jobs past their TTL, or the oldest ones once we exceed a cap,
// so a service left running for weeks doesn't accumulate logs in memory forever.
function cleanup() {
    const now = Date.now()
    for (const job of jobs.values()) {
        if (job.status !== 'running' && now - job.createdAt > JOB_TTL_MS) {
            jobs.delete(job.id)
        }
    }

    const finished = [...jobs.values()].filter((job) => job.status !== 'running')
    if (finished.length > MAX_FINISHED_JOBS) {
        finished
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(0, finished.length - MAX_FINISHED_JOBS)
            .forEach((job) => jobs.delete(job.id))
    }
}

module.exports = { createJob, appendLog, finish, fail, getJob }
