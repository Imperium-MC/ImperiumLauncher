const test   = require('node:test')
const assert = require('node:assert')
const fs     = require('fs-extra')
const os     = require('os')
const path   = require('path')

const CrashScreen = require('../app/assets/js/crashscreen')

test('crash summary takes the deepest Caused by line and Fabric provided-by mod', () => {
    const tail = [
        '[main/INFO]: Loading Minecraft 26.3 with Fabric Loader 0.16.9',
        '[main/ERROR]: Could not execute entrypoint stage \'preLaunch\' due to errors, provided by \'sodium\' at SodiumPreLaunch',
        'java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll',
        '\tat org.lwjgl.system.Library.loadSystem(Library.java:177)',
        'Caused by: java.lang.RuntimeException: inner failure',
        'Caused by: java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll'
    ]
    const summary = CrashScreen._parseCrashSummary(tail)

    assert.strictEqual(summary.cause, 'java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll')
    assert.strictEqual(summary.mod, 'sodium')
})

test('crash summary tolerates logs without a cause or mod', () => {
    const summary = CrashScreen._parseCrashSummary(['[main/INFO]: nothing to see here'])

    assert.strictEqual(summary.cause, null)
    assert.strictEqual(summary.mod, null)
})

test('crash report listing filters non-report files and missing folders', { timeout: 20000 }, async (t) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imperium-crashscreen-'))
    t.after(() => fs.remove(workDir))
    const crashDir = path.join(workDir, 'crash-reports')

    // Missing folder: no crash reports.
    assert.deepStrictEqual(CrashScreen._listCrashReports(crashDir), [])

    await fs.ensureDir(crashDir)
    await fs.writeFile(path.join(crashDir, 'crash-2026-10-18_09.30.00-client.txt'), 'old report')
    await fs.writeFile(path.join(crashDir, 'latest.log'), 'not a crash report')

    assert.deepStrictEqual(CrashScreen._listCrashReports(crashDir), ['crash-2026-10-18_09.30.00-client.txt'])
})

test('lang keys for the crash overlay resolve', () => {
    const LangLoader = require('../app/assets/js/langloader')
    LangLoader.setupLanguage()

    assert.strictEqual(LangLoader.queryJS('landing.crash.title'), 'The Game Crashed')
    assert.strictEqual(LangLoader.queryJS('landing.crash.providedBy', { mod: 'sodium' }), 'Mod involved: sodium')
    assert.match(LangLoader.queryJS('landing.crash.exited', { code: '1' }), /code 1/)
})

test('the crash payload carries the already-parsed upload fields', { timeout: 20000 }, async (t) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imperium-crashscreen-upload-'))
    t.after(() => fs.remove(workDir))
    const crashDir = path.join(workDir, 'crash-reports')
    await fs.ensureDir(crashDir)
    const reportFile = path.join(crashDir, 'crash-2026-10-18_10.00.00-client.txt')
    await fs.writeFile(reportFile, '---- Minecraft Crash Report ----\n'.repeat(200))

    const captured = []
    CrashScreen.setDispatch((payload) => captured.push(payload))
    t.after(() => CrashScreen.setDispatch(() => {}))

    CrashScreen._show({
        startedAt: Date.now() - 1000,
        shown: false,
        logLines: [
            '[main/INFO]: Loading Minecraft 26.3 with Fabric Loader 0.16.9',
            'provided by \'sodium\' at SodiumPreLaunch',
            'Caused by: java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll'
        ],
        knownCrashFiles: new Set(),
        pollTimer: null,
        mcVersion: '26.3',
        clientVersion: '0.2.0-beta.8'
    }, crashDir, 1)

    assert.strictEqual(captured.length, 1)
    const upload = captured[0].upload
    assert.strictEqual(upload.cause, 'java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll')
    assert.strictEqual(upload.mod, 'sodium')
    assert.strictEqual(upload.mcVersion, '26.3')
    assert.strictEqual(upload.clientVersion, '0.2.0-beta.8')
    assert.ok(upload.logTail.includes('Loading Minecraft 26.3'))
    assert.ok(upload.logTail.includes('lwjgl.dll'))
    assert.ok(upload.crashReport.includes('Minecraft Crash Report'))
    assert.ok(Buffer.byteLength(upload.crashReport, 'utf8') <= 64 * 1024)
})

test('the upload payload is scrubbed at the source; local report text stays verbatim', { timeout: 20000 }, async (t) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imperium-crashscreen-redact-'))
    t.after(() => fs.remove(workDir))
    const crashDir = path.join(workDir, 'crash-reports')
    await fs.ensureDir(crashDir)

    const captured = []
    CrashScreen.setDispatch((payload) => captured.push(payload))
    t.after(() => CrashScreen.setDispatch(() => {}))

    CrashScreen._show({
        startedAt: Date.now() - 1000,
        shown: false,
        logLines: [
            '[main/INFO]: natives at C:\\Users\\MylesThePro\\AppData\\Roaming\\Romanica\\natives',
            '[main/ERROR]: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
            'Caused by: java.io.FileNotFoundException: C:\\Users\\MylesThePro\\Romanica\\config.json (no such file)',
            '\tat org.lwjgl.system.Library.loadSystem(Library.java:177)'
        ],
        knownCrashFiles: new Set(),
        pollTimer: null,
        mcVersion: '26.3',
        clientVersion: '0.2.0-beta.8'
    }, crashDir, 1)

    assert.strictEqual(captured.length, 1)
    const upload = captured[0].upload
    // Scrubbed at the source: no username, no token anywhere in the payload
    // that is handed toward the upload path.
    const flattened = JSON.stringify(upload)
    assert.ok(!flattened.includes('MylesThePro'), 'upload payload must not carry the username')
    assert.ok(!flattened.includes('eyJhbGciOiJIUzI1NiJ9'), 'upload payload must not carry the bearer JWT')
    assert.ok(upload.cause.includes('C:\\Users\\REDACTED\\Romanica\\config.json'))
    assert.ok(upload.logTail.includes('C:\\Users\\REDACTED\\AppData\\Roaming\\Romanica\\natives'))
    assert.ok(upload.logTail.includes('Authorization: Bearer [REDACTED]'))
    // Diagnostics survive.
    assert.ok(upload.logTail.includes('\tat org.lwjgl.system.Library.loadSystem(Library.java:177)'))
    // The local-only fields (clipboard copy, overlay) keep the verbatim
    // text: nothing leaves the machine with those.
    assert.ok(captured[0].reportText.includes('C:\\Users\\MylesThePro'))
    assert.ok(captured[0].reportText.includes('Caused by: java.io.FileNotFoundException: C:\\Users\\MylesThePro\\Romanica\\config.json'))
})
