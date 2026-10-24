/**
 * Module-cache stubs for loading main-process modules under plain node.
 *
 * Nothing runs at require time: node --test also loads this file as a
 * test file, and it must not create directories or touch APPDATA then.
 */
const fs   = require('fs-extra')
const os   = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')

/**
 * Replace a module in the require cache.
 *
 * @param {string} request A resolvable module id or absolute path.
 * @param {Object} exports The stub exports.
 */
function stubModule(request, exports){
    const resolved = require.resolve(request, { paths: [ROOT] })
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports }
    return resolved
}

/**
 * Point APPDATA and electron's userData at fresh temp directories and
 * stub the electron module. Must run before configmanager is required.
 *
 * @param {Object} extra Extra electron exports (ipcMain, shell, ...).
 * @returns {{ appData: string, userData: string }}
 */
function sandboxElectron(extra = {}){
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'romanica-test-'))
    const appData = path.join(base, 'appdata')
    const userData = path.join(base, 'userData')
    fs.ensureDirSync(appData)
    fs.ensureDirSync(userData)
    process.env.APPDATA = appData
    stubModule('electron', Object.assign({
        app: {
            getPath: () => userData,
            getVersion: () => '0.0.0-test',
            isPackaged: false
        },
        shell: {}
    }, extra))
    process.on('exit', () => {
        try { fs.removeSync(base) } catch(_err){ /* best effort */ }
    })
    return { appData, userData }
}

module.exports = { ROOT, stubModule, sandboxElectron }
