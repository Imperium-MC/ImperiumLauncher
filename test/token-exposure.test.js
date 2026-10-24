/**
 * Auth tokens stay in the main process: nothing the renderer receives
 * (bootstrap, config snapshots, auth envelopes) and nothing written to
 * stdout may carry an access, refresh or client token.
 */
const test   = require('node:test')
const assert = require('node:assert')

const { stubModule, sandboxElectron } = require('./helpers/stubs')

const handlers = {}
sandboxElectron({
    ipcMain: {
        handle: (channel, fn) => { handlers[channel] = fn },
        on: (channel, fn) => { handlers[channel] = fn }
    },
    clipboard: {},
    dialog: {}
})

const { RestResponseStatus } = require('helios-core/common')
const realMojang = require('helios-core/mojang')
const mojang = {}
stubModule('helios-core/mojang', Object.assign({}, realMojang, { MojangRestAPI: mojang }))

require('../app/assets/js/langloader').setupLanguage()
const ConfigManager = require('../app/assets/js/configmanager')
ConfigManager.load()
const launchercore = require('../app/main/launchercore')
require('../app/main/ipc').register(() => null)

const SECRETS = ['SECRET-MC-ACCESS', 'SECRET-MS-ACCESS', 'SECRET-MS-REFRESH', 'SECRET-MOJANG-ACCESS', 'SECRET-CLIENT-TOKEN']

function assertNoSecrets(value, where){
    const text = JSON.stringify(value)
    for(const secret of SECRETS){
        assert.ok(!text.includes(secret), `${where} leaks ${secret}`)
    }
}

function seed(){
    ConfigManager.setClientToken('SECRET-CLIENT-TOKEN')
    ConfigManager.addMojangAuthAccount('11111111111111111111111111111111', 'SECRET-MOJANG-ACCESS', 'marcus@example.com', 'Marcus')
    ConfigManager.addMicrosoftAuthAccount('22222222222222222222222222222222', 'SECRET-MC-ACCESS', 'Livia',
        Date.now() + 3600_000, 'SECRET-MS-ACCESS', 'SECRET-MS-REFRESH', Date.now() + 3600_000)
}

test('config snapshots and the bootstrap payload carry no tokens', () => {
    seed()
    const snapshot = launchercore.configSnapshot()
    assertNoSecrets(snapshot, 'configSnapshot()')

    const accounts = snapshot.config.authenticationDatabase
    assert.deepStrictEqual(Object.keys(accounts).sort(), ['11111111111111111111111111111111', '22222222222222222222222222222222'])
    assert.strictEqual(accounts['22222222222222222222222222222222'].displayName, 'Livia')
    assert.strictEqual(accounts['22222222222222222222222222222222'].type, 'microsoft')
    assert.strictEqual(accounts['11111111111111111111111111111111'].username, 'marcus@example.com')
    assert.strictEqual(snapshot.config.selectedAccount, '22222222222222222222222222222222')

    const event = {}
    handlers.IMPERIUM_BOOTSTRAP(event)
    assertNoSecrets(event.returnValue, 'bootstrap')
})

test('the auth validation envelope carries no tokens', async () => {
    seed()
    const res = await handlers.IMPERIUM_AUTH_VALIDATE_SELECTED()
    assert.strictEqual(res.valid, true)
    assert.strictEqual(res.account.uuid, '22222222222222222222222222222222')
    assertNoSecrets(res, 'AUTH_VALIDATE_SELECTED')
})

test('the add-account envelope carries no tokens', async () => {
    mojang.authenticate = async () => ({
        responseStatus: RestResponseStatus.SUCCESS,
        data: {
            accessToken: 'SECRET-MOJANG-ACCESS',
            clientToken: 'SECRET-CLIENT-TOKEN',
            selectedProfile: { id: '33333333333333333333333333333333', name: 'Titus' }
        }
    })
    const res = await handlers.IMPERIUM_AUTH_ADD_MOJANG(null, 'titus@example.com', 'hunter2')
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.account.displayName, 'Titus')
    assertNoSecrets(res, 'AUTH_ADD_MOJANG')
})

test('adding a Mojang account prints no session tokens', async (t) => {
    mojang.authenticate = async () => ({
        responseStatus: RestResponseStatus.SUCCESS,
        data: {
            accessToken: 'SECRET-MOJANG-ACCESS',
            clientToken: 'SECRET-CLIENT-TOKEN',
            selectedProfile: { id: '55555555555555555555555555555555', name: 'Gaius' }
        }
    })
    const printed = []
    for(const method of ['log', 'info', 'warn', 'error', 'debug']){
        t.mock.method(console, method, (...args) => printed.push(args))
    }
    await handlers.IMPERIUM_AUTH_ADD_MOJANG(null, 'gaius@example.com', 'hunter2')
    t.mock.restoreAll()
    assertNoSecrets(printed.map(args => args.map(String).join(' ').concat(JSON.stringify(args))), 'console output')
})

test('the renderer can no longer write raw tokens through CONFIG_APPLY', () => {
    const attempts = {
        addMojangAuthAccount: ['44444444444444444444444444444444', 'planted-token', 'x@example.com', 'Planted'],
        addMicrosoftAuthAccount: ['44444444444444444444444444444444', 'planted-token', 'Planted', 1, 'planted-ms', 'planted-refresh', 1]
    }
    for(const [op, args] of Object.entries(attempts)){
        const res = handlers.IMPERIUM_CONFIG_APPLY(null, op, args)
        assert.strictEqual(res.ok, false, `${op} must not be an allowed config op`)
    }
    assert.strictEqual(ConfigManager.getAuthAccount('44444444444444444444444444444444'), undefined)
})
