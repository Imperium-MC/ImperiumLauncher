const test   = require('node:test')
const assert = require('node:assert')
const fs     = require('fs-extra')
const path   = require('path')

const { sandboxElectron } = require('./helpers/stubs')
const { userData } = sandboxElectron()

const ConfigManager = require('../app/assets/js/configmanager')

const configPath = path.join(userData, 'config.json')

const ACCOUNT = {
    type: 'microsoft',
    accessToken: 'mc-token',
    username: 'Marcus',
    uuid: '0123456789abcdef0123456789abcdef',
    displayName: 'Marcus',
    expiresAt: 1,
    microsoft: { access_token: 'ms-token', refresh_token: 'ms-refresh', expires_at: 1 }
}

function seedConfig(){
    ConfigManager.load()
    ConfigManager.addMicrosoftAuthAccount(ACCOUNT.uuid, ACCOUNT.accessToken, ACCOUNT.username, 1,
        ACCOUNT.microsoft.access_token, ACCOUNT.microsoft.refresh_token, 1)
    ConfigManager.ensureJavaConfig('Romanica', { suggestedMajor: 25 }, null)
    ConfigManager.setJavaExecutable('Romanica', 'C:\\java\\bin\\javaw.exe')
    ConfigManager.save()
}

function corruptBackups(){
    return fs.readdirSync(userData).filter(f => f.startsWith('config.json.corrupt-'))
}

test('a save that dies mid-write leaves the previous config.json intact', (t) => {
    seedConfig()
    const before = fs.readFileSync(configPath, 'utf8')

    // Simulate the process dying halfway through the write: half the
    // bytes reach the target file, then the write throws.
    const realWrite = fs.writeFileSync
    fs.writeFileSync = function(file, data, ...rest){
        realWrite.call(fs, file, String(data).slice(0, Math.floor(String(data).length / 2)), ...rest)
        throw new Error('simulated crash mid-write')
    }
    t.after(() => { fs.writeFileSync = realWrite })

    ConfigManager.setGameWidth(1920)
    assert.throws(() => ConfigManager.save())
    fs.writeFileSync = realWrite

    const after = fs.readFileSync(configPath, 'utf8')
    assert.strictEqual(after, before, 'config.json must not be truncated by a failed save')
    assert.doesNotThrow(() => JSON.parse(after))
})

test('a corrupt config.json is preserved and its accounts are salvaged', () => {
    seedConfig()
    const full = fs.readFileSync(configPath, 'utf8')
    // Truncate after the auth database but before the end of the file.
    const cut = full.indexOf('"modConfigurations"')
    assert.ok(cut > 0)
    const truncated = full.slice(0, cut + 10)
    fs.writeFileSync(configPath, truncated)

    for(const f of corruptBackups()){
        fs.removeSync(path.join(userData, f))
    }

    ConfigManager.load()

    const backups = corruptBackups()
    assert.strictEqual(backups.length, 1, 'the corrupt file is kept for inspection')
    assert.strictEqual(fs.readFileSync(path.join(userData, backups[0]), 'utf8'), truncated)

    const acc = ConfigManager.getAuthAccount(ACCOUNT.uuid)
    assert.ok(acc != null, 'stored account survives the corrupt file')
    assert.strictEqual(acc.microsoft.refresh_token, ACCOUNT.microsoft.refresh_token)
    assert.strictEqual(ConfigManager.getSelectedAccount()?.uuid, ACCOUNT.uuid)
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(configPath, 'utf8')))
})

test('regenerated defaults are a copy, not the DEFAULT_CONFIG object', () => {
    fs.writeFileSync(configPath, '{{{ not json')
    ConfigManager.load()
    const defaultDir = ConfigManager.getDataDirectory(true)
    ConfigManager.setDataDirectory(path.join(userData, 'elsewhere'))
    assert.strictEqual(ConfigManager.getDataDirectory(true), defaultDir,
        'mutating the live config must not change the defaults')
})

test('getSelectedServer(true) returns the default server, not the client token', () => {
    fs.writeFileSync(configPath, '{{{ not json')
    ConfigManager.load()
    ConfigManager.setClientToken('client-token-value')
    assert.strictEqual(ConfigManager.getSelectedServer(true), null)
})
