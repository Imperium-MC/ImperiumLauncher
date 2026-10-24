const test         = require('node:test')
const assert       = require('node:assert')
const crypto       = require('crypto')
const EventEmitter = require('events')
const fs           = require('fs-extra')
const os           = require('os')
const path         = require('path')

const { stubModule } = require('./helpers/stubs')

const JS = path.resolve(__dirname, '..', 'app', 'assets', 'js')

/* ------------------------------------------------------------------ */
/* Stubs: everything the pipeline touches outside launchservice.js     */
/* ------------------------------------------------------------------ */

stubModule('electron', { app: { getVersion: () => '0.0.0-test' } })

const javaStub = Object.assign({}, require('helios-core/java'), {
    latestOpenJDK: async () => javaStub.nextAsset,
    extractJdk: async () => path.join(os.tmpdir(), 'fake-jdk', 'bin', 'javaw.exe'),
    validateSelectedJvm: async () => ({})
})
stubModule('helios-core/java', javaStub)

const dlStub = Object.assign({}, require('helios-core/dl'), {
    downloadFile: async (url, dest, onProgress) => dlStub.nextDownload(url, dest, onProgress),
    MojangIndexProcessor: class { async getVersionJson(){ return {} } },
    DistributionIndexProcessor: class { async loadModLoaderVersionJson(){ return {} } }
})
stubModule('helios-core/dl', dlStub)

class FakeRepair {
    spawnReceiver(){ this.childProcess = new EventEmitter() }
    async verifyFiles(){ return 0 }
    destroyReceiver(){}
}
stubModule(path.join(JS, 'assetdl.js'), { ImperiumRepair: FakeRepair })
stubModule(path.join(JS, 'managedmodcleanup.js'), { reapStaleManagedModules: async () => ({ removed: [] }) })
stubModule(path.join(JS, 'discordwrapper.js'), { initRPC(){}, shutdownRPC(){}, updateDetails(){} })
stubModule(path.join(JS, 'crashscreen.js'), { setDispatch(){} })

class FakeProcessBuilder {
    constructor(_serv, _versionData, _modLoaderData, authUser){
        this.authUser = authUser
    }
    build(){
        const child = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        FakeProcessBuilder.lastChild = child
        return child
    }
}
stubModule(path.join(JS, 'processbuilder.js'), FakeProcessBuilder)

const launchservice = require('../app/main/launchservice')

/* ------------------------------------------------------------------ */
/* Fake launcher core                                                  */
/* ------------------------------------------------------------------ */

const account = { uuid: '0123456789abcdef0123456789abcdef', displayName: 'Marcus', type: 'microsoft' }
const server = { rawServer: { id: 'Romanica', minecraftVersion: '26.3', discord: null } }
const distro = { getServerById: () => server, rawDistribution: { discord: null } }

const core = {
    refresh: async () => distro,
    DistroAPI: {
        refreshDistributionOrFallback: () => core.refresh(),
        isDevMode: () => false
    },
    ConfigManager: {
        getSelectedServer: () => 'Romanica',
        getSelectedAccount: () => account,
        getCommonDirectory: () => path.join(os.tmpdir(), 'romanica-ls-common'),
        getInstanceDirectory: () => path.join(os.tmpdir(), 'romanica-ls-instances'),
        getLauncherDirectory: () => path.join(os.tmpdir(), 'romanica-ls-launcher'),
        getDataDirectory: () => path.join(os.tmpdir(), 'romanica-ls-data'),
        setJavaExecutable(){},
        save(){}
    },
    buildSummary: () => ({}),
    LangLoader: { queryJS: (key) => key }
}

const events = []
launchservice.init(core, (e) => events.push(e))

function deferred(){
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

const settleWithin = (p, ms) => Promise.race([
    p, new Promise((_res, rej) => setTimeout(() => rej(new Error(`not settled within ${ms}ms`)), ms))
])

test.afterEach(() => {
    core.refresh = async () => distro
    account.displayName = 'Marcus'
})

/* ------------------------------------------------------------------ */
/* Launch mutex                                                        */
/* ------------------------------------------------------------------ */

test('a second launch while one is in flight is refused', async () => {
    const gate = deferred()
    core.refresh = () => gate.promise

    const first = launchservice.launch()
    const second = await settleWithin(launchservice.launch(), 1000)
    assert.deepStrictEqual(second, { ok: false, busy: true })

    gate.resolve(distro)
    assert.strictEqual((await first).ok, true)

    // The guard is released once the first launch settles.
    assert.strictEqual((await settleWithin(launchservice.launch(), 1000)).ok, true)
})

test('a launch that throws releases the guard', async () => {
    core.refresh = async () => { throw new Error('offline') }
    assert.strictEqual((await launchservice.launch()).ok, false)

    core.refresh = async () => distro
    assert.strictEqual((await settleWithin(launchservice.launch(), 1000)).ok, true)
})

/* ------------------------------------------------------------------ */
/* Game process lifetime                                               */
/* ------------------------------------------------------------------ */

test('the game process is released when it exits without Discord RPC', async () => {
    assert.strictEqual((await launchservice.launch()).ok, true)
    assert.strictEqual(launchservice.isGameRunning(), true)

    FakeProcessBuilder.lastChild.emit('close', 0, null)
    assert.strictEqual(launchservice.isGameRunning(), false)
})

test('a player name with regex metacharacters does not break the launch', async () => {
    account.displayName = 'Mar(cus'
    assert.strictEqual((await launchservice.launch()).ok, true)
})

/* ------------------------------------------------------------------ */
/* JDK download verification                                           */
/* ------------------------------------------------------------------ */

async function jdkFixture(t, served){
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'romanica-jdk-'))
    t.after(() => fs.remove(dir))
    const expected = Buffer.from('the real temurin archive bytes')
    javaStub.nextAsset = {
        id: 'OpenJDK25U-jre_x64_windows_hotspot.zip',
        url: 'https://example.invalid/jdk.zip',
        path: path.join(dir, 'jdk.zip'),
        size: expected.length,
        algo: 'sha256',
        hash: crypto.createHash('sha256').update(expected).digest('hex')
    }
    dlStub.nextDownload = async (_url, dest, onProgress) => {
        const body = served(expected)
        await fs.writeFile(dest, body)
        onProgress({ transferred: body.length })
    }
}

const JAVA_OPTS = { suggestedMajor: 25, supported: '>=25' }

test('a same-size tampered JDK download is rejected', async (t) => {
    await jdkFixture(t, (expected) => Buffer.alloc(expected.length, 0x41))
    const res = await launchservice.javaDownload(JAVA_OPTS)
    assert.strictEqual(res.ok, false)
    assert.strictEqual(res.desc, 'landing.downloadJava.javaDownloadCorruptedError')
})

test('a JDK download that matches its hash is installed', async (t) => {
    await jdkFixture(t, (expected) => expected)
    const res = await launchservice.javaDownload(JAVA_OPTS)
    assert.strictEqual(res.ok, true)
})
