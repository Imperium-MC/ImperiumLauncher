const test         = require('node:test')
const assert       = require('node:assert')
const childProcess = require('child_process')
const crypto       = require('crypto')
const fs           = require('fs-extra')
const http         = require('http')
const os           = require('os')
const path         = require('path')

const assetdlPath = path.resolve(__dirname, '..', 'app', 'assets', 'js', 'assetdl.js')
const { pickVerification, MAX_RETRIES } = require(assetdlPath)

const GOOD    = Buffer.from('A'.repeat(4096))
const CORRUPT = Buffer.from('B'.repeat(4096)) // same size, wrong content

/**
 * Fork assetdl.js as a receiver child (exactly like ImperiumRepair does)
 * and drive a standalone download stage with fixture assets. Resolves
 * once the stage completes (or errors) and the child has exited; on
 * success the receiver is disconnected the same way the transmitter's
 * destroyReceiver() does.
 */
function runReceiver(assets) {
    return new Promise((resolve, reject) => {
        const events = { retries: 0, requests: 0, complete: false, error: null, exitCode: null }
        const child = childProcess.fork(assetdlPath, [], {
            env: { ...process.env, ASSETDL_RETRY_BASE_MS: '1' },
            stdio: ['pipe', 'pipe', 'pipe', 'ipc']
        })
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
            // Mirror ImperiumRepair.destroyReceiver(): the receiver exits
            // cleanly once its IPC channel is gone.
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
        child.on('exit', (code) => {
            // Covers exits not preceded by a terminal message.
            clearTimeout(timeout)
            events.exitCode = code
        })
        child.send({ action: 'download', assets })
    })
}

function startFixtureServer(body) {
    return new Promise((resolve) => {
        let requests = 0
        const server = http.createServer((req, res) => {
            requests++
            res.writeHead(200, { 'Content-Length': body.length })
            res.end(body)
        })
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/file.jar`, requestCount: () => requests }))
    })
}

test('pickVerification prefers distro sha256 over the processor hash', () => {
    const asset = { id: 'com.example:mod:1.0', algo: 'md5', hash: 'd41d8cd98f00b204e9800998ecf8427e' }

    assert.deepStrictEqual(
        pickVerification(asset, { 'com.example:mod:1.0': 'a'.repeat(64) }),
        { algo: 'sha256', hash: 'a'.repeat(64) }
    )
    // No sha256 in the distro -> keep the validate-stage hash untouched.
    assert.deepStrictEqual(
        pickVerification(asset, {}),
        { algo: 'md5', hash: 'd41d8cd98f00b204e9800998ecf8427e' }
    )
})

test('same-size corrupt download is retried 3 times, then fails the sync', { timeout: 30000 }, async (t) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imperium-assetdl-'))
    t.after(() => fs.remove(workDir))
    const fixture = await startFixtureServer(CORRUPT)
    t.after(() => new Promise(resolve => fixture.server.close(resolve)))

    const dest = path.join(workDir, 'mod.jar')
    const events = await runReceiver([{
        id: 'com.example:mod:1.0',
        // Hash of the GOOD content: the served CORRUPT body has the exact
        // same size, so only hash verification can catch it.
        algo: 'md5',
        hash: crypto.createHash('md5').update(GOOD).digest('hex'),
        size: CORRUPT.length,
        url: fixture.url,
        path: dest
    }])

    // Initial attempt + 3 retries.
    assert.strictEqual(fixture.requestCount(), MAX_RETRIES + 1, 'expected 4 download attempts')
    assert.strictEqual(events.retries, MAX_RETRIES, 'expected 3 retry events')
    // The sync must fail with a verification error, never complete...
    assert.strictEqual(events.complete, false, 'download must not complete with an unverified file')
    assert.ok(events.error != null, 'expected an error message')
    assert.match(events.error.displayable, /failed verification/)
    assert.match(events.error.displayable, /mod\.jar/)
    // ...the receiver must exit non-zero so the launcher can never spawn the game...
    assert.notStrictEqual(events.exitCode, 0)
    // ...and the corrupt file must not be left behind for the next sync to trust.
    assert.strictEqual(await fs.pathExists(dest), false, 'corrupt file must be deleted')
})

test('matching download completes and the file stays on disk', { timeout: 30000 }, async (t) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imperium-assetdl-ok-'))
    t.after(() => fs.remove(workDir))
    const fixture = await startFixtureServer(CORRUPT)
    t.after(() => new Promise(resolve => fixture.server.close(resolve)))

    const dest = path.join(workDir, 'mod.jar')
    const events = await runReceiver([{
        id: 'com.example:mod:1.0',
        algo: 'md5',
        hash: crypto.createHash('md5').update(CORRUPT).digest('hex'),
        size: CORRUPT.length,
        url: fixture.url,
        path: dest
    }])

    assert.strictEqual(events.error, null)
    assert.strictEqual(events.complete, true)
    assert.strictEqual(events.exitCode, 0)
    assert.strictEqual(fixture.requestCount(), 1, 'a verified download needs no retries')
    assert.strictEqual((await fs.readFile(dest)).equals(CORRUPT), true)
})
