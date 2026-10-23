const test         = require('node:test')
const assert       = require('node:assert')
const childProcess = require('child_process')
const crypto       = require('crypto')
const fs           = require('fs-extra')
const http         = require('http')
const os           = require('os')
const path         = require('path')

const { HeliosDistribution } = require('helios-core/common')

const assetdlPath = path.resolve(__dirname, '..', 'app', 'assets', 'js', 'assetdl.js')
const {
    fallbackFilenameFromId,
    hasUndefinedSegment
} = require(assetdlPath)
const {
    reapStaleManagedModules,
    isManagedLayout,
    MANIFEST_FILE
} = require(path.resolve(__dirname, '..', 'app', 'assets', 'js', 'managedmodcleanup.js'))

const CLIENT_B24  = Buffer.from('imperium-client-0.2.0-beta.24-payload')
const SODIUM_093  = Buffer.from('sodium-0.9.3-payload')

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex')

/* ------------------------------------------------------------------ */
/* Undefined file-name defenses (issue #14, task 2)                    */
/* ------------------------------------------------------------------ */

test('fallbackFilenameFromId slugifies a module id, never "undefined"', () => {
    assert.strictEqual(
        fallbackFilenameFromId('com.modrinth.sodium:mc26.3-0.9.3-beta.1-fabric'),
        'com.modrinth.sodium-mc26.3-0.9.3-beta.1-fabric.jar'
    )
    assert.strictEqual(fallbackFilenameFromId(undefined), 'module.jar')
    assert.strictEqual(fallbackFilenameFromId(''), 'module.jar')
    assert.strictEqual(fallbackFilenameFromId(':::'), 'module.jar')
    // A component that literally says "undefined" still slugifies to a real
    // name — the file name is never bare "undefined.jar".
    assert.strictEqual(fallbackFilenameFromId('a:b:undefined'), 'a-b-undefined.jar')
    assert.notStrictEqual(fallbackFilenameFromId('a:b:undefined'), 'undefined.jar')
})

test('hasUndefinedSegment detects the pre-#14 path shape anywhere in the tree', () => {
    assert.strictEqual(hasUndefinedSegment('C:/x/mods/fabric/com/modrinth/sodium/0.9.3/undefined/0.9.3-undefined.jar'), true)
    assert.strictEqual(hasUndefinedSegment(path.join('mods', 'fabric', 'undefined.jar')), true)
    assert.strictEqual(hasUndefinedSegment('C:/x/mods/fabric/net/imperiummc/imperium-client/0.2.0-beta.24/imperium-client-0.2.0-beta.24.jar'), false)
    assert.strictEqual(hasUndefinedSegment('C:/x/mods/fabric/sodium/0.9.3-notundefined.jar'), false)
})

test('receiver refuses to download an asset whose path contains "undefined"', { timeout: 30000 }, async (t) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'romanica-undef-guard-'))
    t.after(() => fs.remove(workDir))

    const dest = path.join(workDir, 'com', 'modrinth', 'sodium', '0.9.3', 'undefined', '0.9.3-undefined.jar')
    const events = await runReceiver([{
        id: 'com.modrinth.sodium:0.9.3',
        algo: 'md5',
        hash: md5(SODIUM_093),
        size: SODIUM_093.length,
        url: 'http://127.0.0.1:1/never-fetched.jar', // guard must fire before any request
        path: dest
    }], t)

    assert.strictEqual(events.complete, false, 'the sync must not complete')
    assert.ok(events.error != null, 'expected a displayable error')
    assert.match(events.error.displayable, /invalid name/)
    assert.match(events.error.displayable, /com\.modrinth\.sodium:0\.9\.3/)
    assert.match(events.error.displayable, /com\.modrinth\.sodium-0\.9\.3\.jar/)
    assert.notStrictEqual(events.exitCode, 0, 'receiver must exit non-zero')
    assert.strictEqual(await fs.pathExists(dest), false, 'no file may be written')
})

/* ------------------------------------------------------------------ */
/* Managed-layout recognition (issue #14, task 1)                      */
/* ------------------------------------------------------------------ */

test('isManagedLayout accepts helios layouts and rejects player-shaped files', () => {
    // helios-core's deterministic maven layout.
    assert.strictEqual(isManagedLayout('net/imperiummc/imperium-client/0.2.0-beta.24/imperium-client-0.2.0-beta.24.jar'), true)
    assert.strictEqual(isManagedLayout('com/modrinth/sodium/0.9.3/sodium-0.9.3.jar'), true)
    assert.strictEqual(isManagedLayout('grp/art/1.0/art-1.0-classifier.jar'), true) // classifier variant
    // The pre-#14 two-component-id shape.
    assert.strictEqual(isManagedLayout('com/modrinth/sodium/0.9.3/undefined/0.9.3-undefined.jar'), true)
    // Player files: wrong shape, wrong name, or deliberately renamed.
    assert.strictEqual(isManagedLayout('user-added-mod-1.0.jar'), false)
    assert.strictEqual(isManagedLayout('imperium-client-0.2.0-beta.24.jar'), false)
    assert.strictEqual(isManagedLayout('net/imperiummc/imperium-client/0.2.0-beta.23/custom-thing.jar'), false)
    assert.strictEqual(isManagedLayout('net/imperiummc/imperium-client/0.2.0-beta.23/imperium-client-0.2.0-beta.23.jar.disabled'), false)
    assert.strictEqual(isManagedLayout('undefined/undefined.jar'), false)
    assert.strictEqual(isManagedLayout('x/undefined/undefined.jar'), false)
    assert.strictEqual(isManagedLayout(''), false)
})

/* ------------------------------------------------------------------ */
/* The issue #14 gate: a fixture-profile sync removes the stale        */
/* version and keeps the active one. Temp dir only — never %APPDATA%.  */
/* ------------------------------------------------------------------ */

test('sync on a fixture profile reaps stale managed versions and keeps the active one', { timeout: 60000 }, async (t) => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'romanica-cleanup-profile-'))
    t.after(() => fs.remove(profile))
    const commonDir   = path.join(profile, 'common')
    const instanceDir = path.join(profile, 'instances')

    const fixture = await startFixtureServer({
        'client-b24.jar': CLIENT_B24,
        'sodium.jar': SODIUM_093
    })
    t.after(() => new Promise(resolve => fixture.server.close(resolve)))

    // The current distribution: client beta.24 + sodium on the FIXED
    // three-component id (com.modrinth:<slug>:<version>).
    const rawDistro = {
        version: '1.0.0',
        servers: [{
            id: 'RomanicaTest',
            name: 'Romanica Test',
            description: 'fixture server',
            version: '1.0.0',
            address: 'play.romanica.net',
            minecraftVersion: '26.3',
            mainServer: true,
            modules: [
                {
                    id: 'net.imperiummc:imperium-client:0.2.0-beta.24',
                    name: 'Imperium Client',
                    type: 'FabricMod',
                    required: { value: true, def: true },
                    artifact: { size: CLIENT_B24.length, MD5: md5(CLIENT_B24), url: `${fixture.url}/client-b24.jar` }
                },
                {
                    id: 'com.modrinth:sodium:0.9.3',
                    name: 'Sodium',
                    type: 'FabricMod',
                    required: { value: false, def: true },
                    artifact: { size: SODIUM_093.length, MD5: md5(SODIUM_093), url: `${fixture.url}/sodium.jar` }
                }
            ]
        }]
    }
    const distro = new HeliosDistribution(rawDistro, commonDir, instanceDir)
    const clientModule = distro.servers[0].modules[0]
    const sodiumModule = distro.servers[0].modules[1]

    const modsFabric = path.join(commonDir, 'mods', 'fabric')

    // Stale launcher-managed versions left behind by older syncs.
    const staleBeta23 = path.join(modsFabric, 'net', 'imperiummc', 'imperium-client',
        '0.2.0-beta.23', 'imperium-client-0.2.0-beta.23.jar')
    const staleBeta22 = path.join(modsFabric, 'net', 'imperiummc', 'imperium-client',
        '0.2.0-beta.22', 'imperium-client-0.2.0-beta.22.jar')
    // The pre-#14 undefined-name shape (two-component sodium id).
    const staleUndefined = path.join(modsFabric, 'com', 'modrinth', 'sodium',
        '0.9.3', 'undefined', '0.9.3-undefined.jar')
    await Promise.all([
        fs.outputFile(staleBeta23, 'stale beta.23 payload'),
        fs.outputFile(staleBeta22, 'stale beta.22 payload'),
        fs.outputFile(staleUndefined, 'stale undefined-name payload')
    ])

    // Player-owned files that must survive every cleanup.
    const userFiles = [
        path.join(modsFabric, 'user-added-mod-1.0.jar'),                                  // loose in the managed root
        path.join(modsFabric, 'net', 'imperiummc', 'imperium-client',
            '0.2.0-beta.23', 'custom-thing.jar'),                                          // sibling a player renamed in
        path.join(instanceDir, 'RomanicaTest', 'mods', 'user-dropped.jar')                 // drop-in mods dir
    ]
    await Promise.all(userFiles.map(file => fs.outputFile(file, 'player content')))

    // --- The sync: install every missing referenced module through the REAL
    // receiver (forked assetdl.js, exactly like ImperiumRepair), then reap.
    const events = await runReceiver([
        { id: clientModule.rawModule.id, algo: 'md5', hash: md5(CLIENT_B24), size: CLIENT_B24.length, url: `${fixture.url}/client-b24.jar`, path: clientModule.getPath() },
        { id: sodiumModule.rawModule.id, algo: 'md5', hash: md5(SODIUM_093), size: SODIUM_093.length, url: `${fixture.url}/sodium.jar`, path: sodiumModule.getPath() }
    ], t)
    assert.strictEqual(events.error, null, 'fixture sync must succeed')
    assert.strictEqual(events.complete, true)
    assert.strictEqual((await fs.readFile(clientModule.getPath())).equals(CLIENT_B24), true, 'active client downloaded + verified')

    const result = await reapStaleManagedModules(distro, commonDir)
    // Exactly the three stale launcher-managed files are reported removed.
    assert.deepStrictEqual(
        result.removed.map(p => path.resolve(p)).sort(),
        [staleBeta23, staleBeta22, staleUndefined].map(p => path.resolve(p)).sort()
    )

    // Stale managed versions are gone...
    assert.strictEqual(await fs.pathExists(staleBeta23), false, 'stale beta.23 must be removed')
    assert.strictEqual(await fs.pathExists(staleBeta22), false, 'stale beta.22 must be removed')
    assert.strictEqual(await fs.pathExists(staleUndefined), false, 'undefined-name sodium jar must be removed')
    // ...including its now-empty version directory (pruning stops at non-empty dirs).
    assert.strictEqual(await fs.pathExists(path.dirname(staleBeta22)), false, 'empty version dir must be pruned')
    assert.strictEqual(await fs.pathExists(path.dirname(staleBeta23)), true, 'dir holding a player file must survive')
    // The active version and its verified content stay.
    assert.strictEqual(await fs.pathExists(clientModule.getPath()), true, 'active client must be kept')
    assert.strictEqual(await fs.pathExists(sodiumModule.getPath()), true, 'referenced sodium must be kept')
    // Player files are never touched.
    for(const file of userFiles){
        assert.strictEqual(await fs.pathExists(file), true, `player file must survive: ${path.basename(file)}`)
    }
    // Provenance manifest now tracks exactly the referenced files.
    const manifest = await fs.readJson(path.join(commonDir, MANIFEST_FILE))
    const posix = (p) => path.relative(commonDir, p).split(path.sep).join('/')
    assert.deepStrictEqual(
        manifest.files.sort(),
        [posix(clientModule.getPath()), posix(sodiumModule.getPath())].sort()
    )

    // Second pass is a no-op: the manifest already matches the distro.
    const second = await reapStaleManagedModules(distro, commonDir)
    assert.deepStrictEqual(second.removed, [], 'second cleanup must remove nothing')
    for(const file of userFiles){
        assert.strictEqual(await fs.pathExists(file), true)
    }
})

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Fork assetdl.js as a receiver child (exactly like ImperiumRepair) and
 * drive the standalone download stage with fixture assets. Mirrors the
 * technique of assetdl-verification.test.js.
 */
function runReceiver(assets, t) {
    return new Promise((resolve, reject) => {
        const events = { retries: 0, complete: false, error: null, exitCode: null }
        const child = childProcess.fork(assetdlPath, [], {
            env: { ...process.env, ASSETDL_RETRY_BASE_MS: '1' },
            stdio: ['pipe', 'pipe', 'pipe', 'ipc']
        })
        t.after(() => { try { child.kill() } catch(_err) { /* already gone */ } })
        const timeout = setTimeout(() => {
            child.kill()
            reject(new Error('receiver child timed out'))
        }, 25000)
        const settle = () => {
            child.on('exit', (code) => {
                clearTimeout(timeout)
                events.exitCode = code
                resolve(events)
            })
            if(child.connected) {
                child.disconnect()
            }
        }
        child.on('message', (message) => {
            switch(message.response) {
                case 'downloadRetry':
                    events.retries++
                    break
                case 'downloadComplete':
                    events.complete = true
                    settle()
                    break
                case 'error':
                    events.error = message
                    settle()
                    break
            }
        })
        child.send({ action: 'download', assets })
    })
}

/**
 * Fixture HTTP server serving named buffers under /<name>.
 */
function startFixtureServer(bodies) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const body = bodies[req.url.slice(1)] ?? Buffer.from('not found')
            res.writeHead(bodies[req.url.slice(1)] ? 200 : 404, { 'Content-Length': body.length })
            res.end(body)
        })
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
    })
}
