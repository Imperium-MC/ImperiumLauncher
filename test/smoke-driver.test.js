const test   = require('node:test')
const assert = require('node:assert')
const fs     = require('fs-extra')
const os     = require('os')
const path   = require('path')
const { EventEmitter } = require('events')

const smoke = require('./smoke/launch-smoke.cjs')

// runSmoke wipes and reseeds %APPDATA%/<productName>; never let the tests do
// that to the real launcher config of whoever runs them.
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'imperium-smoke-appdata-'))

/* ------------------------------------------------------------------ */
/* 1. The pre-seeded config parses through the real ConfigManager      */
/* ------------------------------------------------------------------ */

test('the pre-seeded config survives ConfigManager load() intact', { timeout: 20000 }, async (t) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imperium-smoke-cfg-'))
    t.after(() => fs.remove(workDir))

    const javaExec = path.join(workDir, 'jre', 'bin', 'javaw.exe')
    const dataDir = path.join(workDir, 'data')
    const config = smoke.buildSmokeConfig({
        serverId: 'ImperiumMC',
        uuid: '00000000-0000-0000-0000-000000000000',
        name: 'SmokeTest',
        dataDir,
        javaExec
    })

    // Seed the module cache with an electron stub so configmanager (which
    // only needs app.getPath) loads under plain node. Same technique as
    // test/processbuilder-natives.test.js.
    const electronPath = require.resolve('electron')
    const previous = require.cache[electronPath]
    require.cache[electronPath] = {
        id: electronPath,
        filename: electronPath,
        loaded: true,
        exports: { app: { getPath: (_name) => workDir } }
    }
    t.after(() => {
        if(previous != null){
            require.cache[electronPath] = previous
        } else {
            delete require.cache[electronPath]
        }
        const configManagerPath = path.resolve(__dirname, '..', 'app', 'assets', 'js', 'configmanager.js')
        delete require.cache[configManagerPath]
    })

    const ConfigManager = require('../app/assets/js/configmanager')

    // Write the seeded config exactly where the launcher will read it and
    // run the real loader.
    await fs.ensureDir(workDir)
    await fs.writeFile(path.join(workDir, 'config.json'), JSON.stringify(config, null, 4))
    ConfigManager.load()

    assert.strictEqual(ConfigManager.getSelectedServer(), 'ImperiumMC')
    const account = ConfigManager.getSelectedAccount()
    assert.ok(account != null, 'selected account must resolve')
    assert.strictEqual(account.accessToken, '0')
    assert.strictEqual(account.displayName, 'SmokeTest')
    assert.strictEqual(account.type, 'mojang')
    assert.strictEqual(ConfigManager.getJavaExecutable('ImperiumMC'), javaExec)
    assert.strictEqual(ConfigManager.getAutoConnect(), false, 'autoConnect must stay off (title screen only)')
    assert.strictEqual(ConfigManager.getLaunchDetached(), false, 'launchDetached must keep javaw in the launcher tree')
    assert.strictEqual(ConfigManager.getMinRAM('ImperiumMC'), '4096M')
    assert.deepStrictEqual(ConfigManager.getJVMOptions('ImperiumMC'), config.javaConfig.ImperiumMC.jvmOptions)

    // The seeded account is byte-identical in shape to what the launcher
    // itself serializes via addMojangAuthAccount.
    const canonical = ConfigManager.addMojangAuthAccount(
        '11111111-1111-1111-1111-111111111111', '0', 'SmokeTest', 'SmokeTest')
    assert.deepStrictEqual(
        Object.keys(config.authenticationDatabase['00000000-0000-0000-0000-000000000000']).sort(),
        Object.keys(canonical).sort()
    )
})

/* ------------------------------------------------------------------ */
/* 2. Marker classification                                            */
/* ------------------------------------------------------------------ */

test('scanLog classifies the title-screen marker as a pass', () => {
    const verdict = smoke.scanLog([
        '[main/INFO]: Loading Minecraft 26.3 with Fabric Loader 0.16.9',
        '[Render thread/INFO]: Backend library: LWJGL version: 3.3.6',
        '[Render thread/INFO]: Reloading ResourceManager: vanilla',
        '[Render thread/INFO]: Sound engine started'
    ].join('\n'))
    assert.strictEqual(verdict.passed, true)
    assert.strictEqual(verdict.failed, false)
})

test('scanLog classifies each startup failure marker as a fail', () => {
    const failures = [
        'java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll',
        'net.fabricmc.loader.impl.FormattedException: Could not execute entrypoint stage \'main\'',
        'Mixin apply failed for mixin foo',
        'Exception in thread "Render thread" java.lang.IllegalStateException',
        'Crash report saved to .\\crash-reports\\crash-2026-10-18_10.00.00-client.txt',
        'Failed to create window'
    ]
    for(const line of failures){
        const verdict = smoke.scanLog(`[main/INFO]: booting\n${line}\n`)
        assert.strictEqual(verdict.failed, true, `expected failure for: ${line}`)
        assert.strictEqual(verdict.passed, false)
    }
})

test('scanLog fails closed even when a pass marker also appears', () => {
    const verdict = smoke.scanLog('Sound engine started\njava.lang.UnsatisfiedLinkError: boom')
    assert.strictEqual(verdict.failed, true)
    assert.strictEqual(verdict.passed, false)
})

test('scanLog stays neutral on ordinary boot noise', () => {
    const verdict = smoke.scanLog('[main/INFO]: Loading Minecraft 26.3 with Fabric Loader 0.16.9')
    assert.deepStrictEqual(verdict, { passed: false, failed: false, match: null })
})

/* ------------------------------------------------------------------ */
/* 3. Pure helpers                                                     */
/* ------------------------------------------------------------------ */

test('userDataDir follows the productName the way Electron names userData', () => {
    const pkg = { name: 'romanicalauncher', productName: 'Romanica Launcher' }
    assert.strictEqual(
        smoke.userDataDir(pkg, path.join('C:', 'Users', 'runner', 'AppData', 'Roaming')),
        path.join('C:', 'Users', 'runner', 'AppData', 'Roaming', 'Romanica Launcher')
    )
    assert.strictEqual(
        smoke.userDataDir({ name: 'fallback' }, path.join('X:', 'AppData')),
        path.join('X:', 'AppData', 'fallback')
    )
})

test('parseArgs converts kebab-case flags to camelCase keys', () => {
    const parsed = smoke.parseArgs([
        '--exe', 'dist/win-unpacked/Romanica Launcher.exe',
        '--data-dir', 'D:/smoke-data',
        '--java-home', 'D:/jre',
        '--artifacts-dir', 'D:/artifacts',
        '--mesa', 'D:/mesa/x64/opengl32.dll',
        '--server', 'ImperiumMC'
    ])
    assert.strictEqual(parsed.exe, 'dist/win-unpacked/Romanica Launcher.exe')
    assert.strictEqual(parsed.dataDir, 'D:/smoke-data')
    assert.strictEqual(parsed.javaHome, 'D:/jre')
    assert.strictEqual(parsed.artifactsDir, 'D:/artifacts')
    assert.strictEqual(parsed.mesa, 'D:/mesa/x64/opengl32.dll')
    assert.strictEqual(parsed.server, 'ImperiumMC')
})

/* ------------------------------------------------------------------ */
/* 4. runSmoke with a mocked spawn                                     */
/* ------------------------------------------------------------------ */

/**
 * Build a fake launcher process and the disk state runSmoke expects.
 */
async function makeFixture(t, { logLines }){
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imperium-smoke-run-'))
    t.after(() => fs.remove(workDir))

    const javaHome = path.join(workDir, 'jre')
    await fs.ensureDir(path.join(javaHome, 'bin'))
    await fs.writeFile(path.join(javaHome, 'bin', 'javaw.exe'), 'fake')
    const mesaDll = path.join(workDir, 'mesa', 'opengl32.dll')
    await fs.ensureDir(path.dirname(mesaDll))
    await fs.writeFile(mesaDll, 'fake mesa dll')

    const dataDir = path.join(workDir, 'data')
    const artifactsDir = path.join(workDir, 'artifacts')

    const child = new EventEmitter()
    child.pid = 4242
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}

    const events = { killed: 0 }
    const spawnImpl = () => {
        // The launcher announces the spawn, then the "game" writes its log.
        setImmediate(() => child.stdout.emit('data', Buffer.from('[SMOKE] game spawned\n')))
        if(logLines != null){
            setImmediate(async () => {
                await fs.ensureDir(path.join(dataDir, 'instances', 'ImperiumMC', 'logs'))
                await fs.writeFile(
                    path.join(dataDir, 'instances', 'ImperiumMC', 'logs', 'latest.log'),
                    logLines.join('\n')
                )
            })
        }
        return child
    }

    return {
        workDir, dataDir, javaHome, mesaDll, artifactsDir, child, events,
        options: {
            exe: path.join(workDir, 'Romanica Launcher.exe'),
            dataDir,
            javaHome,
            mesaDll,
            artifactsDir,
            serverId: 'ImperiumMC',
            pollMs: 10,
            syncTimeoutMs: 5000,
            gameTimeoutMs: 5000
        },
        deps: {
            spawnImpl,
            kill: () => {
                events.killed++
                child.emit('exit', 0)
            }
        }
    }
}

test('runSmoke passes when the game log reaches the title screen', { timeout: 20000 }, async (t) => {
    const fixture = await makeFixture(t, {
        logLines: [
            '[main/INFO]: Loading Minecraft 26.3 with Fabric Loader 0.16.9',
            '[Render thread/INFO]: Sound engine started'
        ]
    })
    const result = await smoke.runSmoke(fixture.options, fixture.deps)

    assert.strictEqual(result.ok, true, result.reason)
    assert.strictEqual(fixture.events.killed, 1, 'the process tree must be cleaned up')
    // Mesa was placed next to javaw.exe before the launch.
    assert.strictEqual(fs.existsSync(path.join(fixture.javaHome, 'bin', 'opengl32.dll')), true)
    // The seeded config landed in the userData-shaped path.
    const uDir = smoke.userDataDir(
        JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')),
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    assert.strictEqual(fs.existsSync(path.join(uDir, 'config.json')), true)
    // The launcher log and the game log snapshot were kept as artifacts.
    assert.strictEqual(fs.existsSync(path.join(fixture.artifactsDir, 'launcher-stdout.log')), true)
    assert.strictEqual(fs.existsSync(path.join(fixture.artifactsDir, 'latest.log')), true)
})

test('runSmoke does not pass on the previous run\'s title-screen log', { timeout: 20000 }, async (t) => {
    const fixture = await makeFixture(t, { logLines: null })
    const logs = path.join(fixture.dataDir, 'instances', 'ImperiumMC', 'logs')
    await fs.ensureDir(logs)
    await fs.writeFile(path.join(logs, 'latest.log'), '[Render thread/INFO]: Sound engine started\n')
    fixture.options.gameTimeoutMs = 500
    const result = await smoke.runSmoke(fixture.options, fixture.deps)

    assert.strictEqual(result.ok, false, result.reason)
})

test('runSmoke fails when the game log shows a startup failure', { timeout: 20000 }, async (t) => {
    const fixture = await makeFixture(t, {
        logLines: [
            '[main/INFO]: Loading Minecraft 26.3 with Fabric Loader 0.16.9',
            'java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll'
        ]
    })
    const result = await smoke.runSmoke(fixture.options, fixture.deps)

    assert.strictEqual(result.ok, false)
    assert.match(result.reason, /UnsatisfiedLinkError|failure marker/)
    assert.strictEqual(fixture.events.killed, 1)
})

test('runSmoke fails when the launcher dies before spawning the game', { timeout: 20000 }, async (t) => {
    const fixture = await makeFixture(t, { logLines: null })
    fixture.deps.spawnImpl = () => {
        const child = new EventEmitter()
        child.pid = 4242
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = () => {}
        setImmediate(() => child.emit('exit', 1))
        return child
    }
    const result = await smoke.runSmoke(fixture.options, fixture.deps)

    assert.strictEqual(result.ok, false)
    assert.match(result.reason, /launcher exited with code 1 before spawning/)
})

test('runSmoke fails when the launcher reports a pipeline failure', { timeout: 20000 }, async (t) => {
    const fixture = await makeFixture(t, { logLines: null })
    fixture.deps.spawnImpl = () => {
        const child = new EventEmitter()
        child.pid = 4242
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = () => {}
        setImmediate(() => child.stdout.emit('data', Buffer.from('[SMOKE] launch pipeline reported failure\n')))
        return child
    }
    const result = await smoke.runSmoke(fixture.options, fixture.deps)

    assert.strictEqual(result.ok, false)
    assert.match(result.reason, /pipeline failure/)
})

test('runSmoke times out when the title screen never appears', { timeout: 20000 }, async (t) => {
    const fixture = await makeFixture(t, {
        logLines: ['[main/INFO]: Loading Minecraft 26.3 with Fabric Loader 0.16.9']
    })
    fixture.options.gameTimeoutMs = 300
    const result = await smoke.runSmoke(fixture.options, fixture.deps)

    assert.strictEqual(result.ok, false)
    assert.match(result.reason, /timed out waiting for the title-screen/)
})

test('runSmoke rejects a missing java executable before spawning anything', { timeout: 20000 }, async (t) => {
    const fixture = await makeFixture(t, { logLines: null })
    fixture.options.javaHome = path.join(fixture.workDir, 'no-java')
    fixture.deps.spawnImpl = () => {
        throw new Error('spawn must not be reached')
    }
    const result = await smoke.runSmoke(fixture.options, fixture.deps)

    assert.strictEqual(result.ok, false)
    assert.match(result.reason, /java executable not found/)
})
