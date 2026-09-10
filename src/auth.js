const crypto = require('crypto')
const config = require('./config')

// Guards every route (except /health) so a random web page cannot drive this
// LAN service just by knowing its localhost port; the operator must have
// pasted the one-time pairing token (printed on first run) into the caller.
function requireAuth(req, res, next) {
    const header = req.headers.authorization || ''
    const match = header.match(/^Bearer (.+)$/)
    const provided = Buffer.from(match ? match[1] : '')
    const expected = Buffer.from(config.get().pairingToken || '')

    const ok = expected.length > 0 && provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
    if (!ok) {
        return res.status(401).json({ error: 'unauthorized' })
    }
    next()
}

module.exports = { requireAuth }
