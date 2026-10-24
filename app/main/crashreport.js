/**
 * crashreport.js — uploads a game crash report to the ImperiumMC endpoint.
 *
 * The renderer is sandboxed and CSP-bound, so the POST happens here in the
 * main process: the crash screen hands the already-parsed fields through
 * the bridge, this module validates them, clamps the payload to the
 * endpoint's limits, and fetches with a hard timeout. Everything that
 * maps a response to a UI-facing result is a pure function so the whole
 * pipeline is testable under plain node (see test/crashreport.test.js).
 *
 * Endpoint: POST https://api.romanica.net/api/v2/client/crash-report
 *   {launcher, launcherVersion, clientVersion?, mcVersion?, platform,
 *    cause, mod?, logTail <=32KB, crashReport? <=64KB}
 *   -> {id, url, truncated}; anonymous, 5 requests/hour/IP.
 *
 * REDACTION: the free-text fields (cause, logTail, crashReport) are scrubbed
 * here with the shared rule set (see app/main/redact.js for the rule block
 * mirrored in the backend) BEFORE clamping and before any network send —
 * this is the last gate in front of the POST, so a caller that bypasses the
 * crash screen's own scrub still cannot leak. The scrub is idempotent, so
 * text already redacted by crashscreen.js passes through unchanged.
 */
const ENDPOINT = 'https://api.romanica.net/api/v2/client/crash-report'

const { redactText } = require('./redact')

const LIMITS = {
    // Aligned to the backend's clamps (crashReports.ts): the server re-clamps to
    // these same values, so pre-truncating here means what we send is what lands
    // (cross-repo audit 2026-10-23 — the old 1024/256/128 silently disagreed).
    cause: 200,
    mod: 200,
    clientVersion: 64,
    mcVersion: 64,
    logTail: 32 * 1024,
    crashReport: 64 * 1024
}

const DEFAULT_TIMEOUT_MS = 10 * 1000

/**
 * Truncate a string to at most maxBytes of UTF-8 without splitting a
 * code point.
 *
 * @param {string} value The string.
 * @param {number} maxBytes The byte budget.
 * @returns {string} The truncated string.
 */
function truncateToBytes(value, maxBytes){
    if(typeof value !== 'string' || Buffer.byteLength(value, 'utf8') <= maxBytes){
        return value
    }
    let bytes = Buffer.from(value, 'utf8').subarray(0, maxBytes)
    // Drop trailing bytes until the cut lands on a code point boundary.
    while(bytes.length > 0){
        const last = bytes[bytes.length - 1]
        if((last & 0xc0) === 0x80){
            // Continuation byte: the code point is cut in half.
            bytes = bytes.subarray(0, bytes.length - 1)
        } else if((last & 0x80) !== 0){
            // Lead byte of a now-incomplete sequence.
            bytes = bytes.subarray(0, bytes.length - 1)
            break
        } else {
            break
        }
    }
    return bytes.toString('utf8')
}

/**
 * Validate the renderer-supplied fields and build the request body with
 * launcher metadata attached. Pure: no network, no clock.
 *
 * @param {Object} fields {cause, mod?, clientVersion?, mcVersion?,
 * logTail, crashReport?} as parsed by the crash screen.
 * @param {Object} meta {launcher, launcherVersion, platform} supplied by
 * the main process, never by the renderer.
 * @returns {{ok: true, body: Object}} | {{ok: false, error: string}}
 */
function buildBody(fields, meta){
    if(fields == null || typeof fields !== 'object'){
        return { ok: false, error: 'invalid' }
    }
    if(meta == null || typeof meta !== 'object'
        || typeof meta.launcher !== 'string' || meta.launcher.length === 0
        || typeof meta.launcherVersion !== 'string' || meta.launcherVersion.length === 0
        || typeof meta.platform !== 'string' || meta.platform.length === 0){
        return { ok: false, error: 'invalid' }
    }
    if(typeof fields.cause !== 'string' || fields.cause.length === 0 || fields.cause.length > LIMITS.cause){
        return { ok: false, error: 'invalid' }
    }
    if(fields.logTail == null || typeof fields.logTail !== 'string'){
        return { ok: false, error: 'invalid' }
    }
    if(fields.crashReport != null && typeof fields.crashReport !== 'string'){
        return { ok: false, error: 'invalid' }
    }
    if(fields.mod != null && (typeof fields.mod !== 'string' || fields.mod.length > LIMITS.mod)){
        return { ok: false, error: 'invalid' }
    }
    if(fields.clientVersion != null && (typeof fields.clientVersion !== 'string' || fields.clientVersion.length > LIMITS.clientVersion)){
        return { ok: false, error: 'invalid' }
    }
    if(fields.mcVersion != null && (typeof fields.mcVersion !== 'string' || fields.mcVersion.length > LIMITS.mcVersion)){
        return { ok: false, error: 'invalid' }
    }

    const body = {
        launcher: meta.launcher,
        launcherVersion: meta.launcherVersion,
        platform: meta.platform,
        // Scrub first, then clamp: a truncated token is a partial leak, so
        // redaction must see the whole field and the byte budget applies to
        // the scrubbed form that actually goes on the wire.
        cause: truncateToBytes(redactText(fields.cause), LIMITS.cause),
        logTail: truncateToBytes(redactText(fields.logTail), LIMITS.logTail)
    }
    if(fields.clientVersion != null){
        body.clientVersion = fields.clientVersion
    }
    if(fields.mcVersion != null){
        body.mcVersion = fields.mcVersion
    }
    if(fields.mod != null && fields.mod.length > 0){
        body.mod = fields.mod
    }
    if(fields.crashReport != null && fields.crashReport.length > 0){
        body.crashReport = truncateToBytes(redactText(fields.crashReport), LIMITS.crashReport)
    }
    return { ok: true, body }
}

/**
 * Map an endpoint response to the result the crash overlay displays.
 * Pure.
 *
 * @param {number} status The HTTP status code.
 * @param {Object|null} json The parsed response body, when it parsed.
 * @returns {{ok: true, url: string, id: ?string, truncated: boolean}} |
 * {{ok: false, error: 'rate_limited'|'too_large'|'bad_response'|'server'}}
 */
function mapResponse(status, json){
    if(status === 429){
        return { ok: false, error: 'rate_limited' }
    }
    if(status === 413){
        return { ok: false, error: 'too_large' }
    }
    if(status >= 200 && status < 300){
        if(json != null && typeof json.url === 'string' && json.url.length > 0){
            return {
                ok: true,
                url: json.url,
                id: typeof json.id === 'string' ? json.id : null,
                // Backend sends {logTail,crashReport} booleans (audit 2026-10-23); truthy = trimmed.
                truncated: !!(json.truncated && (json.truncated.logTail || json.truncated.crashReport))
            }
        }
        return { ok: false, error: 'bad_response' }
    }
    return { ok: false, error: 'server' }
}

/**
 * Validate, upload and map. Never throws; every failure path comes back
 * as {ok: false, error} so the overlay can fall back to Copy Report.
 *
 * @param {Object} fields The crash screen fields.
 * @param {Object} [options] {meta, endpoint, fetchImpl, timeoutMs} — the
 * non-default options exist for the test suite.
 * @returns {Promise.<Object>} The UI-facing result.
 */
async function upload(fields, options = {}){
    const meta = options.meta != null ? options.meta : {
        launcher: 'RomanicaLauncher',
        // Filled in by the IPC layer; a missing version means a caller
        // outside the bridge, which still gets a deterministic body.
        launcherVersion: '0',
        platform: process.platform
    }
    const endpoint = options.endpoint != null ? options.endpoint : ENDPOINT
    const fetchImpl = options.fetchImpl != null ? options.fetchImpl : fetch
    const timeoutMs = options.timeoutMs != null ? options.timeoutMs : DEFAULT_TIMEOUT_MS

    const built = buildBody(fields, meta)
    if(!built.ok){
        return built
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(built.body),
            signal: controller.signal
        })
        let json = null
        try {
            json = await response.json()
        } catch(_err){
            json = null
        }
        return mapResponse(response.status, json)
    } catch(err){
        if(err != null && (err.name === 'AbortError' || controller.signal.aborted)){
            return { ok: false, error: 'timeout' }
        }
        return { ok: false, error: 'network' }
    } finally {
        clearTimeout(timer)
    }
}

exports.ENDPOINT = ENDPOINT
exports.LIMITS = LIMITS
exports.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS
exports.truncateToBytes = truncateToBytes
exports.buildBody = buildBody
exports.mapResponse = mapResponse
exports.upload = upload
