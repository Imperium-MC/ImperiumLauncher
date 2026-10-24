const test   = require('node:test')
const assert = require('node:assert')
const os     = require('os')
const path   = require('path')

const { getMojangOS } = require('helios-core/common')
const { stubModule } = require('./helpers/stubs')

stubModule(path.resolve(__dirname, '..', 'app', 'assets', 'js', 'configmanager.js'), {
    getMaxRAM: () => '4G',
    getMinRAM: () => '2G',
    getJVMOptions: () => [],
    getFullscreen: () => false
})

const ProcessBuilder = require('../app/assets/js/processbuilder')

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function jvmArgsFor(rule){
    const fakeThis = {
        vanillaManifest: {
            arguments: {
                jvm: [{ rules: [rule], value: '-Dromanica.rule=matched' }],
                game: []
            }
        },
        modManifest: { arguments: { jvm: null, game: [] }, mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient' },
        server: { rawServer: { id: 'Romanica' } },
        _processAutoConnectArg: () => {}
    }
    return ProcessBuilder.prototype._constructJVMArguments113.call(fakeThis, [], 'natives')
}

test('an os.version rule is matched against the running OS release', () => {
    const args = jvmArgsFor({
        action: 'allow',
        os: { name: getMojangOS(), version: `^${escapeRegex(os.release())}$` }
    })
    assert.ok(args.includes('-Dromanica.rule=matched'), 'rule for this exact OS release must apply')
})

test('an os.version rule for another release does not apply', () => {
    const args = jvmArgsFor({
        action: 'allow',
        os: { name: getMojangOS(), version: '^0\\.0\\.0-never$' }
    })
    assert.ok(!args.includes('-Dromanica.rule=matched'))
})
