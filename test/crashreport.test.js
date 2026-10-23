const test   = require('node:test')
const assert = require('node:assert')
const http   = require('node:http')

const CrashReport = require('../app/main/crashreport')

/* Field set shaped exactly like the crash screen's upload payload. */
function sampleFields(overrides = {}){
    return Object.assign({
        cause: 'java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll',
        mod: 'sodium',
        mcVersion: '26.3',
        clientVersion: '0.2.0-beta.8',
        logTail: '[main/INFO]: Loading Minecraft 26.3 with Fabric Loader 0.16.9\n[main/ERROR]: boom',
        crashReport: '---- Minecraft Crash Report ----\nwhatever'
    }, overrides)
}

const SAMPLE_META = { launcher: 'RomanicaLauncher', launcherVersion: '0.1.3', platform: 'win32' }

/**
 * Start a one-request fixture server.
 *
 * @param {function(Object, Object, function(Object))} handler Receives the
 * parsed body, the raw request, and a finish(response) callback.
 * @returns {Promise.<{server: http.Server, url: string}>}
 */
function fixtureServer(handler){
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks = []
            req.on('data', (chunk) => chunks.push(chunk))
            req.on('end', () => {
                let body = null
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                } catch(_err){
                    body = null
                }
                handler(body, req, (response) => {
                    res.writeHead(response.status, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify(response.body))
                })
            })
        })
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, url: `http://127.0.0.1:${server.address().port}/api/v2/client/crash-report` })
        })
    })
}

test('buildBody clamps logTail and crashReport to the endpoint limits', () => {
    const bigTail = 'x'.repeat(CrashReport.LIMITS.logTail + 4096)
    const bigReport = 'y'.repeat(CrashReport.LIMITS.crashReport + 4096)

    const built = CrashReport.buildBody(sampleFields({ logTail: bigTail, crashReport: bigReport }), SAMPLE_META)

    assert.strictEqual(built.ok, true)
    assert.ok(Buffer.byteLength(built.body.logTail, 'utf8') <= CrashReport.LIMITS.logTail)
    assert.ok(Buffer.byteLength(built.body.crashReport, 'utf8') <= CrashReport.LIMITS.crashReport)
    assert.strictEqual(built.body.launcher, 'RomanicaLauncher')
    assert.strictEqual(built.body.launcherVersion, '0.1.3')
    assert.strictEqual(built.body.platform, 'win32')
    assert.strictEqual(built.body.cause, sampleFields().cause)
    assert.strictEqual(built.body.mod, 'sodium')
    assert.strictEqual(built.body.mcVersion, '26.3')
    assert.strictEqual(built.body.clientVersion, '0.2.0-beta.8')

    // A genuinely huge tail (the bridge's loose sanity bound lets it
    // through) is still clamped, never rejected.
    const huge = CrashReport.buildBody(sampleFields({ logTail: 'z'.repeat(200 * 1024) }), SAMPLE_META)
    assert.strictEqual(huge.ok, true)
    assert.ok(Buffer.byteLength(huge.body.logTail, 'utf8') <= CrashReport.LIMITS.logTail)
})

test('buildBody truncates on a code point boundary', () => {
    // 3-byte code point repeated; any byte cut would split the last one.
    const text = '\u263A'.repeat(20000) // 60000 bytes
    const clamped = CrashReport.truncateToBytes(text, 32767)
    assert.ok(Buffer.byteLength(clamped, 'utf8') <= 32767)
    assert.ok(clamped.endsWith('\u263A'), 'cut must not split a code point')
    assert.strictEqual(clamped.length, 10922) // 32766 bytes = 10922 smiles
    // Under the budget: untouched.
    assert.strictEqual(CrashReport.truncateToBytes('\u263A'.repeat(10), 32767), '\u263A'.repeat(10))
})

test('buildBody rejects malformed fields without touching the network', async () => {
    const badPayloads = [
        null,
        { cause: 'x' },                                   // no logTail
        Object.assign(sampleFields(), { cause: '' }),      // empty cause
        Object.assign(sampleFields(), { cause: 42 }),
        Object.assign(sampleFields(), { logTail: 100 }),
        Object.assign(sampleFields(), { mod: {} }),
        Object.assign(sampleFields(), { mcVersion: 123 })
    ]
    for(const payload of badPayloads){
        const built = CrashReport.buildBody(payload, SAMPLE_META)
        assert.deepStrictEqual(built, { ok: false, error: 'invalid' })
    }

    let called = false
    const result = await CrashReport.upload(null, {
        meta: SAMPLE_META,
        fetchImpl: async () => {
            called = true
            throw new Error('must not be reached')
        }
    })
    assert.deepStrictEqual(result, { ok: false, error: 'invalid' })
    assert.strictEqual(called, false)
})

test('mapResponse produces the UI-facing result for each endpoint shape', () => {
    assert.deepStrictEqual(
        CrashReport.mapResponse(200, { id: 'abc123', url: 'https://api.romanica.net/crash/abc123', truncated: false }),
        { ok: true, url: 'https://api.romanica.net/crash/abc123', id: 'abc123', truncated: false }
    )
    assert.deepStrictEqual(
        CrashReport.mapResponse(200, { url: 'https://api.romanica.net/crash/x', truncated: true }),
        { ok: true, url: 'https://api.romanica.net/crash/x', id: null, truncated: true }
    )
    assert.deepStrictEqual(CrashReport.mapResponse(200, { id: 'no-url' }), { ok: false, error: 'bad_response' })
    assert.deepStrictEqual(CrashReport.mapResponse(200, null), { ok: false, error: 'bad_response' })
    assert.deepStrictEqual(CrashReport.mapResponse(429, { error: 'rate limited' }), { ok: false, error: 'rate_limited' })
    assert.deepStrictEqual(CrashReport.mapResponse(413, null), { ok: false, error: 'too_large' })
    assert.deepStrictEqual(CrashReport.mapResponse(500, null), { ok: false, error: 'server' })
    assert.deepStrictEqual(CrashReport.mapResponse(503, { error: 'down' }), { ok: false, error: 'server' })
})

test('upload round-trips against a live success fixture', { timeout: 10000 }, async (t) => {
    let seen = null
    const { server, url } = await fixtureServer((body, req, finish) => {
        seen = { body, method: req.method, contentType: req.headers['content-type'] }
        finish({ status: 200, body: { id: 'smoke-1', url: 'https://api.romanica.net/crash/smoke-1', truncated: false } })
    })
    t.after(() => new Promise((resolve) => server.close(resolve)))

    const result = await CrashReport.upload(sampleFields(), { endpoint: url, meta: SAMPLE_META })

    assert.deepStrictEqual(result, {
        ok: true, url: 'https://api.romanica.net/crash/smoke-1', id: 'smoke-1', truncated: false
    })
    assert.strictEqual(seen.method, 'POST')
    assert.ok(seen.contentType.startsWith('application/json'))
    assert.strictEqual(seen.body.cause, sampleFields().cause)
    assert.strictEqual(seen.body.logTail, sampleFields().logTail)
})

test('upload maps a 429 rate-limit response to the fallback state', { timeout: 10000 }, async (t) => {
    const { server, url } = await fixtureServer((_body, _req, finish) => {
        finish({ status: 429, body: { error: 'rate limited' } })
    })
    t.after(() => new Promise((resolve) => server.close(resolve)))

    const result = await CrashReport.upload(sampleFields(), { endpoint: url, meta: SAMPLE_META })

    assert.deepStrictEqual(result, { ok: false, error: 'rate_limited' })
})

test('upload maps a connection failure to the network fallback', { timeout: 10000 }, async () => {
    // A server that is closed before the request: plain ECONNREFUSED.
    const { server, url } = await fixtureServer(() => {})
    await new Promise((resolve) => server.close(resolve))

    const result = await CrashReport.upload(sampleFields(), { endpoint: url, meta: SAMPLE_META })

    assert.deepStrictEqual(result, { ok: false, error: 'network' })
})

test('upload times out when the endpoint never answers', { timeout: 10000 }, async (t) => {
    const { server, url } = await fixtureServer(() => { /* never responds */ })
    t.after(() => new Promise((resolve) => server.close(resolve)))

    const started = Date.now()
    const result = await CrashReport.upload(sampleFields(), { endpoint: url, meta: SAMPLE_META, timeoutMs: 250 })

    assert.deepStrictEqual(result, { ok: false, error: 'timeout' })
    assert.ok(Date.now() - started >= 200, 'the timeout must actually elapse')
})
