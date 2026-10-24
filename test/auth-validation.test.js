/**
 * Startup account validation: only a definitive rejection from the auth
 * service may remove a stored account. Network failures, timeouts and
 * 5xx responses keep it (code review pass 2, P1).
 */
const test   = require('node:test')
const assert = require('node:assert')

const { stubModule, sandboxElectron } = require('./helpers/stubs')

const handlers = {}
sandboxElectron({
    ipcMain: {
        handle: (channel, fn) => { handlers[channel] = fn },
        on: () => {}
    },
    clipboard: {},
    dialog: {}
})

const { RestResponseStatus } = require('helios-core/common')
const realMojang = require('helios-core/mojang')
const realMicrosoft = require('helios-core/microsoft')
const { MojangErrorCode } = realMojang
const { MicrosoftErrorCode } = realMicrosoft

const mojang = {}
stubModule('helios-core/mojang', Object.assign({}, realMojang, { MojangRestAPI: mojang }))
const microsoft = {}
stubModule('helios-core/microsoft', Object.assign({}, realMicrosoft, { MicrosoftAuth: microsoft }))

require('../app/assets/js/langloader').setupLanguage()
const ConfigManager = require('../app/assets/js/configmanager')
ConfigManager.load()
require('../app/main/ipc').register(() => null)

const validate = () => handlers.IMPERIUM_AUTH_VALIDATE_SELECTED()

const MOJANG_UUID = '11111111111111111111111111111111'
const MS_UUID = '22222222222222222222222222222222'

const ok = (data) => ({ responseStatus: RestResponseStatus.SUCCESS, data })
const noResponse = () => {
    const error = new Error('getaddrinfo ENOTFOUND')
    error.name = 'RequestError'
    return { responseStatus: RestResponseStatus.ERROR, data: null, error, microsoftErrorCode: MicrosoftErrorCode.UNKNOWN }
}
const httpError = (statusCode, microsoftErrorCode = MicrosoftErrorCode.UNKNOWN) => ({
    responseStatus: RestResponseStatus.ERROR,
    data: null,
    error: { name: 'HTTPError', response: { statusCode } },
    microsoftErrorCode
})

function seedMojang(){
    ConfigManager.addMojangAuthAccount(MOJANG_UUID, 'mojang-token', 'marcus@example.com', 'Marcus')
}

function seedMicrosoft(){
    // MC token expired, MS token still valid: the MC_REFRESH path.
    ConfigManager.addMicrosoftAuthAccount(MS_UUID, 'mc-token', 'Livia', 0, 'ms-token', 'ms-refresh', Date.now() + 3600_000)
}

function microsoftFlow(overrides = {}){
    Object.assign(microsoft, {
        getAccessToken: async () => ok({ access_token: 'ms-token-2', refresh_token: 'ms-refresh-2', expires_in: 3600 }),
        getXBLToken: async () => ok({ Token: 'xbl' }),
        getXSTSToken: async () => ok({ Token: 'xsts' }),
        getMCAccessToken: async () => ok({ access_token: 'mc-token-2', expires_in: 86400 }),
        getMCProfile: async () => ok({ id: MS_UUID, name: 'Livia' })
    }, overrides)
}

test.beforeEach(() => {
    for(const uuid of Object.keys(ConfigManager.getAuthAccounts())){
        ConfigManager.removeAuthAccount(uuid)
    }
})

/* Mojang ----------------------------------------------------------- */

test('mojang: a validate request with no response keeps the account', async () => {
    seedMojang()
    mojang.validate = async () => ({ responseStatus: RestResponseStatus.ERROR, data: false, mojangErrorCode: MojangErrorCode.ERROR_UNREACHABLE })
    const res = await validate()
    assert.strictEqual(res.valid, true)
    assert.ok(ConfigManager.getAuthAccount(MOJANG_UUID) != null, 'account must survive a network failure')
})

test('mojang: a refresh that fails transiently keeps the account', async () => {
    seedMojang()
    mojang.validate = async () => ok(false)
    mojang.refresh = async () => ({ responseStatus: RestResponseStatus.ERROR, data: null, mojangErrorCode: MojangErrorCode.ERROR_UNREACHABLE })
    const res = await validate()
    assert.strictEqual(res.valid, true)
    assert.ok(ConfigManager.getAuthAccount(MOJANG_UUID) != null)
})

test('mojang: a refresh rejected as an invalid token removes the account', async () => {
    seedMojang()
    mojang.validate = async () => ok(false)
    mojang.refresh = async () => ({ responseStatus: RestResponseStatus.ERROR, data: null, mojangErrorCode: MojangErrorCode.ERROR_INVALID_TOKEN })
    const res = await validate()
    assert.strictEqual(res.valid, false)
    assert.strictEqual(ConfigManager.getAuthAccount(MOJANG_UUID), undefined)
})

/* Microsoft -------------------------------------------------------- */

test('microsoft: no response from Xbox Live keeps the account', async () => {
    seedMicrosoft()
    microsoftFlow({ getXBLToken: async () => noResponse() })
    const res = await validate()
    assert.strictEqual(res.valid, true)
    assert.ok(ConfigManager.getAuthAccount(MS_UUID) != null, 'account must survive a network failure')
})

test('microsoft: a 503 from Minecraft services keeps the account', async () => {
    seedMicrosoft()
    microsoftFlow({ getMCAccessToken: async () => httpError(503) })
    const res = await validate()
    assert.strictEqual(res.valid, true)
    assert.ok(ConfigManager.getAuthAccount(MS_UUID) != null)
})

test('microsoft: a thrown exception mid-flow keeps the account', async () => {
    seedMicrosoft()
    microsoftFlow({ getXSTSToken: async () => { throw new Error('socket hang up') } })
    const res = await validate()
    assert.strictEqual(res.valid, true)
    assert.ok(ConfigManager.getAuthAccount(MS_UUID) != null)
})

test('microsoft: a definitive Xbox rejection removes the account', async () => {
    seedMicrosoft()
    microsoftFlow({ getXSTSToken: async () => httpError(401, MicrosoftErrorCode.NO_XBOX_ACCOUNT) })
    const res = await validate()
    assert.strictEqual(res.valid, false)
    assert.strictEqual(ConfigManager.getAuthAccount(MS_UUID), undefined)
})

test('microsoft: a rejected refresh token removes the account', async () => {
    ConfigManager.addMicrosoftAuthAccount(MS_UUID, 'mc-token', 'Livia', 0, 'ms-token', 'ms-refresh', 0)
    microsoftFlow({ getAccessToken: async () => httpError(400) })
    const res = await validate()
    assert.strictEqual(res.valid, false)
    assert.strictEqual(ConfigManager.getAuthAccount(MS_UUID), undefined)
})

test('microsoft: a working refresh stores the new tokens', async () => {
    seedMicrosoft()
    microsoftFlow()
    const res = await validate()
    assert.strictEqual(res.valid, true)
    assert.strictEqual(ConfigManager.getAuthAccount(MS_UUID).accessToken, 'mc-token-2')
})
