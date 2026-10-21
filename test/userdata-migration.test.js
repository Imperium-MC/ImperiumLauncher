const test   = require('node:test')
const assert = require('node:assert')
const fs     = require('fs-extra')
const os     = require('os')
const path   = require('path')

const migration = require('../app/main/userdatamigration')

/* ------------------------------------------------------------------ */
/* Real-filesystem tests over temp dirs                                */
/* ------------------------------------------------------------------ */

async function makeRoot(t){
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'romanica-userdata-'))
    t.after(() => fs.remove(root))
    return root
}

test('migrate copies config.json and the distribution cache into the new userData dir', async (t) => {
    const root = await makeRoot(t)
    const appData = path.join(root, 'appdata')
    const legacy = path.join(appData, 'Imperium Launcher')
    const target = path.join(appData, 'Romanica Launcher')
    await fs.ensureDir(legacy)
    await fs.writeJson(path.join(legacy, 'config.json'), { selectedServer: 'ImperiumMC' })
    await fs.writeJson(path.join(legacy, 'distribution.json'), { version: '1.0.0' })
    // Unknown files must NOT be carried over.
    await fs.writeFile(path.join(legacy, 'GPUCache-junk'), 'junk')

    const result = migration.migrate({ appData, userData: target })

    assert.strictEqual(result.migrated, true)
    assert.deepStrictEqual(result.copied.sort(), ['config.json', 'distribution.json'])
    assert.strictEqual(fs.existsSync(path.join(target, 'config.json')), true)
    assert.strictEqual(fs.existsSync(path.join(target, 'distribution.json')), true)
    assert.strictEqual(fs.existsSync(path.join(target, 'GPUCache-junk')), false, 'unknown files must not be copied')
    assert.deepStrictEqual(
        await fs.readJson(path.join(target, 'config.json')),
        { selectedServer: 'ImperiumMC' }
    )
})

test('migrate keeps the legacy directory untouched as a backup', async (t) => {
    const root = await makeRoot(t)
    const appData = path.join(root, 'appdata')
    const legacy = path.join(appData, 'Imperium Launcher')
    const target = path.join(appData, 'Romanica Launcher')
    await fs.ensureDir(legacy)
    const configBody = JSON.stringify({ marker: 'legacy' }, null, 4)
    await fs.writeFile(path.join(legacy, 'config.json'), configBody)

    migration.migrate({ appData, userData: target })

    assert.strictEqual(fs.existsSync(legacy), true, 'legacy dir must survive')
    assert.strictEqual(await fs.readFile(path.join(legacy, 'config.json'), 'utf8'), configBody,
        'legacy config must be byte-identical (copy, not move)')
})

test('migrate also carries the dev distribution cache when present', async (t) => {
    const root = await makeRoot(t)
    const appData = path.join(root, 'appdata')
    const legacy = path.join(appData, 'Imperium Launcher')
    const target = path.join(appData, 'Romanica Launcher')
    await fs.ensureDir(legacy)
    await fs.writeFile(path.join(legacy, 'config.json'), '{}')
    await fs.writeFile(path.join(legacy, 'distribution_dev.json'), '{}')

    const result = migration.migrate({ appData, userData: target })

    assert.deepStrictEqual(result.copied.sort(), ['config.json', 'distribution_dev.json'])
})

test('migrate is a no-op when the new userData dir already exists', async (t) => {
    const root = await makeRoot(t)
    const appData = path.join(root, 'appdata')
    const legacy = path.join(appData, 'Imperium Launcher')
    const target = path.join(appData, 'Romanica Launcher')
    await fs.ensureDir(legacy)
    await fs.writeFile(path.join(legacy, 'config.json'), '{"legacy":true}')
    await fs.ensureDir(target)
    await fs.writeFile(path.join(target, 'config.json'), '{"current":true}')

    const result = migration.migrate({ appData, userData: target })

    assert.strictEqual(result.migrated, false)
    assert.strictEqual(result.reason, 'destination-exists')
    assert.deepStrictEqual(result.copied, [])
    // The existing profile must not have been merged into or overwritten.
    assert.deepStrictEqual(await fs.readJson(path.join(target, 'config.json')), { current: true })
})

test('migrate is a no-op when there is no legacy directory', async (t) => {
    const root = await makeRoot(t)
    const appData = path.join(root, 'appdata')
    const target = path.join(appData, 'Romanica Launcher')

    const result = migration.migrate({ appData, userData: target })

    assert.strictEqual(result.migrated, false)
    assert.strictEqual(result.reason, 'no-legacy-directory')
    assert.strictEqual(fs.existsSync(target), false, 'nothing should be created')
})

test('migrate tolerates a legacy directory that holds none of the carry-over files', async (t) => {
    const root = await makeRoot(t)
    const appData = path.join(root, 'appdata')
    const legacy = path.join(appData, 'Imperium Launcher')
    const target = path.join(appData, 'Romanica Launcher')
    await fs.ensureDir(legacy)
    await fs.writeFile(path.join(legacy, 'unrelated.txt'), 'x')

    const result = migration.migrate({ appData, userData: target })

    assert.strictEqual(result.migrated, false)
    assert.strictEqual(result.reason, 'legacy-directory-empty')
    assert.strictEqual(fs.existsSync(path.join(target, 'config.json')), false)
})

test('migrate survives a copy failure without throwing', async (t) => {
    const root = await makeRoot(t)
    const appData = path.join(root, 'appdata')
    const legacy = path.join(appData, 'Imperium Launcher')
    await fs.ensureDir(legacy)
    await fs.writeFile(path.join(legacy, 'config.json'), '{}')

    const logged = []
    const result = migration.migrate({
        appData,
        userData: path.join(appData, 'Romanica Launcher'),
        copyFileSync: () => { throw new Error('EACCES: disk on fire') },
        log: (msg) => logged.push(msg)
    })

    assert.strictEqual(result.migrated, false)
    assert.strictEqual(result.reason, 'copy-failed')
    assert.strictEqual(logged.length, 1)
    assert.match(logged[0], /copy failed/)
})

test('migrate rejects invalid paths without touching the filesystem', () => {
    const result = migration.migrate({ appData: undefined, userData: null })
    assert.strictEqual(result.migrated, false)
    assert.strictEqual(result.reason, 'invalid-paths')
})

/* ------------------------------------------------------------------ */
/* init() wiring: electron stub -> real paths -> migrate               */
/* ------------------------------------------------------------------ */

test('init resolves appData/userData from the electron app and delegates to migrate', async (t) => {
    const root = await makeRoot(t)
    const appData = path.join(root, 'appdata')
    const legacy = path.join(appData, 'Imperium Launcher')
    await fs.ensureDir(legacy)
    await fs.writeFile(path.join(legacy, 'config.json'), '{"selectedServer":"ImperiumMC"}')

    // Seed the module cache with an electron stub so the lazy require
    // inside init() resolves to our fake app. Same technique as
    // test/smoke-driver.test.js.
    const electronPath = require.resolve('electron')
    const previous = require.cache[electronPath]
    require.cache[electronPath] = {
        id: electronPath,
        filename: electronPath,
        loaded: true,
        exports: { app: { getPath: (name) => (name === 'userData' ? path.join(appData, 'Romanica Launcher') : appData) } }
    }
    t.after(() => {
        if(previous != null){
            require.cache[electronPath] = previous
        } else {
            delete require.cache[electronPath]
        }
    })

    const messages = []
    const originalLog = console.log
    console.log = (msg) => messages.push(msg)
    try {
        migration.init()
    } finally {
        console.log = originalLog
    }

    assert.strictEqual(fs.existsSync(path.join(appData, 'Romanica Launcher', 'config.json')), true,
        'init must run the real migration against the stubbed paths')
    assert.ok(messages.some((m) => m.includes('[UserDataMigration]')), 'init logs the migration result')
})
