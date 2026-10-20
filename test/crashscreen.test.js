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
