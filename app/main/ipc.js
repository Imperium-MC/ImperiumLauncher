/**
 * ipc.js — the validated bridge between the sandboxed renderer and the
 * main process.
 *
 * Every handler validates its arguments before acting; the renderer gets
 * no generic fs/exec surface, only named operations with strict shapes.
 * Handlers that change persisted state return a fresh config snapshot so
 * the renderer's mirror can resynchronize.
 */
const { app, clipboard, dialog, ipcMain, shell } = require('electron')
const path   = require('path')
const fs     = require('fs-extra')

const ConfigManager  = require('../assets/js/configmanager')
const { DistroAPI }   = require('../assets/js/distromanager')
const AuthManager    = require('../assets/js/authmanager')
const DropinModUtil  = require('../assets/js/dropinmodutil')
const { MojangRestAPI, getServerStatus } = require('helios-core/mojang')
const { RestResponseStatus } = require('helios-core/common')

const launchercore = require('./launchercore')
const launchservice = require('./launchservice')
const crashreport   = require('./crashreport')

// Channel names. Mirrored by the preload (app/preload.js).
const BRIDGE = {
    BOOTSTRAP: 'IMPERIUM_BOOTSTRAP',
    SET_PROGRESS_BAR: 'IMPERIUM_SET_PROGRESS_BAR',
    WINDOW_CLOSE: 'IMPERIUM_WINDOW_CLOSE',
    WINDOW_MINIMIZE: 'IMPERIUM_WINDOW_MINIMIZE',
    WINDOW_TOGGLE_MAXIMIZE: 'IMPERIUM_WINDOW_TOGGLE_MAXIMIZE',
    TOGGLE_DEVTOOLS: 'IMPERIUM_TOGGLE_DEVTOOLS',
    CLIPBOARD_WRITE_TEXT: 'IMPERIUM_CLIPBOARD_WRITE_TEXT',
    OPEN_PATH: 'IMPERIUM_OPEN_PATH',
    SHOW_OPEN_DIALOG: 'IMPERIUM_SHOW_OPEN_DIALOG',
    CONFIG_APPLY: 'IMPERIUM_CONFIG_APPLY',
    CONFIG_SAVE: 'IMPERIUM_CONFIG_SAVE',
    CONFIG_REFRESH: 'IMPERIUM_CONFIG_REFRESH',
    DISTRO_SUMMARY: 'IMPERIUM_DISTRO_SUMMARY',
    DISTRO_REFRESH: 'IMPERIUM_DISTRO_REFRESH',
    SERVER_STATUS: 'IMPERIUM_SERVER_STATUS',
    MOJANG_STATUS: 'IMPERIUM_MOJANG_STATUS',
    AUTH_ADD_MOJANG: 'IMPERIUM_AUTH_ADD_MOJANG',
    AUTH_ADD_MICROSOFT: 'IMPERIUM_AUTH_ADD_MICROSOFT',
    AUTH_REMOVE_MOJANG: 'IMPERIUM_AUTH_REMOVE_MOJANG',
    AUTH_REMOVE_MICROSOFT: 'IMPERIUM_AUTH_REMOVE_MICROSOFT',
    AUTH_VALIDATE_SELECTED: 'IMPERIUM_AUTH_VALIDATE_SELECTED',
    JAVA_SCAN: 'IMPERIUM_JAVA_SCAN',
    JAVA_DOWNLOAD: 'IMPERIUM_JAVA_DOWNLOAD',
    JAVA_VALIDATE: 'IMPERIUM_JAVA_VALIDATE',
    LAUNCH_PREPARE: 'IMPERIUM_LAUNCH_PREPARE',
    LAUNCH: 'IMPERIUM_LAUNCH',
    MODS_SCAN: 'IMPERIUM_MODS_SCAN',
    MODS_TOGGLE: 'IMPERIUM_MODS_TOGGLE',
    MODS_ADD: 'IMPERIUM_MODS_ADD',
    SHADERS_SCAN: 'IMPERIUM_SHADERS_SCAN',
    SHADER_SET: 'IMPERIUM_SHADER_SET',
    LOG: 'IMPERIUM_LOG',
    CRASH_REPORT_UPLOAD: 'IMPERIUM_CRASH_REPORT_UPLOAD'
}

// Renderer events (main -> renderer).
const EVENTS = {
    DISTRO_READY: 'distributionIndexDone',
    DEVTOOLS_OPENED: 'devtoolsOpened',
    LAUNCH_EVENT: 'launchEvent'
}

/* ------------------------- validation helpers ------------------------- */

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0

function invalid(msg){
    return { ok: false, error: { title: 'Invalid request', desc: msg } }
}

/**
 * Assert a value is a string of bounded length.
 *
 * @param {*} v The value.
 * @param {number} max Maximum length.
 * @returns {boolean}
 */
function boundedString(v, max){
    return typeof v === 'string' && v.length <= max
}

/**
 * Ensure an absolute path stays inside one of the launcher-owned roots.
 *
 * @param {string} target The candidate path.
 * @param {string[]} roots Allowed parent directories.
 * @returns {boolean}
 */
function pathContained(target, roots){
    if(typeof target !== 'string' || target.length === 0 || !path.isAbsolute(target)){
        return false
    }
    const resolved = path.resolve(target)
    return roots.some(root => {
        const r = path.resolve(root)
        return resolved === r || resolved.startsWith(r + path.sep)
    })
}

/**
 * The launcher-owned directory roots.
 */
function ownedRoots(){
    return [
        ConfigManager.getInstanceDirectory(),
        ConfigManager.getCommonDirectory(),
        ConfigManager.getDataDirectory(),
        ConfigManager.getLauncherDirectory()
    ]
}

/**
 * Resolve a server from the loaded distribution by id.
 *
 * @param {string} serverId The server id sent by the renderer.
 * @returns {Object|null} The HeliosServer, or null when unknown.
 */
async function serverById(serverId){
    if(!isNonEmptyString(serverId)){
        return null
    }
    const distro = await DistroAPI.getDistribution()
    const server = distro.getServerById(serverId)
    return server != null ? server : null
}

/* --------------------------- config operations ------------------------ */

/**
 * Allowlisted ConfigManager mutations the renderer mirror may request.
 * Each entry validates the argument tuple before it reaches the manager.
 */
const CONFIG_OPS = {
    setSelectedServer: {
        fn: (a) => ConfigManager.setSelectedServer(a[0]),
        validate: (a) => a.length === 1 && (a[0] == null || boundedString(a[0], 128))
    },
    setSelectedAccount: {
        fn: (a) => ConfigManager.setSelectedAccount(a[0]),
        validate: (a) => a.length === 1 && boundedString(a[0], 128)
    },
    setModConfigurations: {
        fn: (a) => ConfigManager.setModConfigurations(a[0]),
        validate: (a) => a.length === 1 && Array.isArray(a[0])
    },
    setModConfiguration: {
        fn: (a) => ConfigManager.setModConfiguration(a[0], a[1]),
        validate: (a) => a.length === 2 && boundedString(a[0], 128) && a[1] != null && typeof a[1] === 'object'
    },
    setMinRAM: {
        fn: (a) => ConfigManager.setMinRAM(a[0], a[1]),
        validate: (a) => a.length === 2 && boundedString(a[0], 128) && boundedString(a[1], 16)
    },
    setMaxRAM: {
        fn: (a) => ConfigManager.setMaxRAM(a[0], a[1]),
        validate: (a) => a.length === 2 && boundedString(a[0], 128) && boundedString(a[1], 16)
    },
    setJavaExecutable: {
        fn: (a) => ConfigManager.setJavaExecutable(a[0], a[1]),
        validate: (a) => a.length === 2 && boundedString(a[0], 128) && (a[1] == null || (typeof a[1] === 'string' && a[1].length <= 1024))
    },
    setJVMOptions: {
        fn: (a) => ConfigManager.setJVMOptions(a[0], a[1]),
        validate: (a) => a.length === 2 && boundedString(a[0], 128) && Array.isArray(a[1]) && a[1].every(o => typeof o === 'string' && o.length <= 512)
    },
    setGameWidth: {
        fn: (a) => ConfigManager.setGameWidth(a[0]),
        validate: (a) => a.length === 1 && Number.isInteger(a[0]) && a[0] >= 0 && a[0] <= 32768
    },
    setGameHeight: {
        fn: (a) => ConfigManager.setGameHeight(a[0]),
        validate: (a) => a.length === 1 && Number.isInteger(a[0]) && a[0] >= 0 && a[0] <= 32768
    },
    setFullscreen: {
        fn: (a) => ConfigManager.setFullscreen(a[0]),
        validate: (a) => a.length === 1 && typeof a[0] === 'boolean'
    },
    setAutoConnect: {
        fn: (a) => ConfigManager.setAutoConnect(a[0]),
        validate: (a) => a.length === 1 && typeof a[0] === 'boolean'
    },
    setLaunchDetached: {
        fn: (a) => ConfigManager.setLaunchDetached(a[0]),
        validate: (a) => a.length === 1 && typeof a[0] === 'boolean'
    },
    setAllowPrerelease: {
        fn: (a) => ConfigManager.setAllowPrerelease(a[0]),
        validate: (a) => a.length === 1 && typeof a[0] === 'boolean'
    },
    setDataDirectory: {
        fn: (a) => ConfigManager.setDataDirectory(a[0]),
        validate: (a) => a.length === 1 && typeof a[1] === 'undefined' && boundedString(a[0], 1024)
    },
    setNewsCache: {
        fn: (a) => ConfigManager.setNewsCache(a[0]),
        validate: (a) => a.length === 1 && a[0] != null && typeof a[0] === 'object'
            && (a[0].date == null || typeof a[0].date === 'number')
            && (a[0].content == null || boundedString(a[0].content, 256))
            && typeof a[0].dismissed === 'boolean'
    },
    setNewsCacheDismissed: {
        fn: (a) => ConfigManager.setNewsCacheDismissed(a[0]),
        validate: (a) => a.length === 1 && typeof a[0] === 'boolean'
    },
    addMojangAuthAccount: {
        fn: (a) => ConfigManager.addMojangAuthAccount(a[0], a[1], a[2], a[3]),
        validate: (a) => a.length === 4 && a.slice(0, 4).every(v => boundedString(v, 512))
    },
    addMicrosoftAuthAccount: {
        // (uuid, accessToken, name, mcExpires, msAccessToken, msRefreshToken, msExpires)
        fn: (a) => ConfigManager.addMicrosoftAuthAccount(a[0], a[1], a[2], a[3], a[4], a[5], a[6]),
        validate: (a) => a.length === 7
            && ['0', '1', '2', '4', '5'].every(i => boundedString(a[i], 4096))
            && typeof a[3] === 'number' && Number.isFinite(a[3])
            && typeof a[6] === 'number' && Number.isFinite(a[6])
    },
    removeAuthAccount: {
        fn: (a) => ConfigManager.removeAuthAccount(a[0]),
        validate: (a) => a.length === 1 && boundedString(a[0], 128)
    }
}

/* ----------------------------- registration --------------------------- */

let getWindow = () => null

/**
 * Register every bridge handler.
 *
 * @param {function} winProvider Returns the launcher BrowserWindow.
 */
exports.register = function(winProvider){
    getWindow = winProvider

    /* bootstrap (synchronous, one round trip at preload time) */
    ipcMain.on(BRIDGE.BOOTSTRAP, (event) => {
        event.returnValue = launchercore.bootstrap()
    })

    /* window operations */
    ipcMain.handle(BRIDGE.SET_PROGRESS_BAR, (_e, value) => {
        // Matches the values the renderer always sent: a fraction in
        // [0,1], 2 for the indeterminate state, -1 to clear.
        const win = getWindow()
        if(win != null && Number.isFinite(value) && value >= -1 && value <= 2){
            win.setProgressBar(value)
        }
        return { ok: true }
    })

    ipcMain.handle(BRIDGE.WINDOW_CLOSE, () => {
        const win = getWindow()
        if(win != null){
            win.close()
        }
        return { ok: true }
    })

    ipcMain.handle(BRIDGE.WINDOW_MINIMIZE, () => {
        const win = getWindow()
        if(win != null){
            win.minimize()
        }
        return { ok: true }
    })

    ipcMain.handle(BRIDGE.WINDOW_TOGGLE_MAXIMIZE, () => {
        const win = getWindow()
        if(win != null){
            if(win.isMaximized()){
                win.unmaximize()
            } else {
                win.maximize()
            }
        }
        return { ok: true }
    })

    ipcMain.handle(BRIDGE.TOGGLE_DEVTOOLS, () => {
        const win = getWindow()
        if(win != null){
            win.webContents.toggleDevTools()
        }
        return { ok: true }
    })

    /* shell-adjacent operations */
    ipcMain.handle(BRIDGE.CLIPBOARD_WRITE_TEXT, (_e, text) => {
        if(typeof text === 'string' && text.length <= 1024*1024){
            clipboard.writeText(text)
            return { ok: true }
        }
        return invalid('Invalid clipboard payload.')
    })

    // Open a launcher-owned folder in the OS file manager. Only
    // directories under the launcher's data roots are eligible.
    ipcMain.handle(BRIDGE.OPEN_PATH, async (_e, target) => {
        if(!pathContained(target, ownedRoots())){
            return invalid('Path is not a launcher directory.')
        }
        try {
            const stat = await fs.stat(target)
            if(!stat.isDirectory()){
                return invalid('Path is not a directory.')
            }
            const error = await shell.openPath(target)
            if(error){
                return { ok: false, error: { title: 'Unable to open folder', desc: String(error) } }
            }
            return { ok: true }
        } catch(_err){
            return invalid('Path does not exist.')
        }
    })

    // Native file/directory picker. Only a fixed set of dialog properties
    // is accepted.
    ipcMain.handle(BRIDGE.SHOW_OPEN_DIALOG, async (_e, options) => {
        const ALLOWED_PROPERTIES = new Set(['openFile', 'openDirectory', 'createDirectory', 'multiSelections'])
        if(options == null || typeof options !== 'object'){
            return { ok: false, canceled: true }
        }
        const properties = Array.isArray(options.properties)
            ? options.properties.filter(p => ALLOWED_PROPERTIES.has(p))
            : []
        const dialogOptions = { properties }
        if(boundedString(options.title, 256)){
            dialogOptions.title = options.title
        }
        if(Array.isArray(options.filters)){
            dialogOptions.filters = options.filters
                .filter(f => f != null && boundedString(f.name, 128) && Array.isArray(f.extensions))
                .map(f => ({ name: f.name, extensions: f.extensions.slice(0, 16).map(String) }))
        }
        const win = getWindow()
        const res = win != null
            ? await dialog.showOpenDialog(win, dialogOptions)
            : await dialog.showOpenDialog(dialogOptions)
        return { ok: true, canceled: res.canceled, filePaths: res.filePaths }
    })

    /* configuration */
    ipcMain.handle(BRIDGE.CONFIG_APPLY, (_e, op, args) => {
        const entry = CONFIG_OPS[op]
        if(entry == null){
            return invalid('Unknown configuration operation.')
        }
        if(!Array.isArray(args) || !entry.validate(args)){
            return invalid('Invalid arguments for configuration operation.')
        }
        entry.fn(args)
        return { ok: true, snapshot: launchercore.configSnapshot() }
    })

    ipcMain.handle(BRIDGE.CONFIG_SAVE, () => {
        ConfigManager.save()
        return { ok: true, snapshot: launchercore.configSnapshot() }
    })

    ipcMain.handle(BRIDGE.CONFIG_REFRESH, () => {
        return { ok: true, snapshot: launchercore.configSnapshot() }
    })

    /* distribution */
    ipcMain.handle(BRIDGE.DISTRO_SUMMARY, async () => {
        const distro = await DistroAPI.getDistribution()
        return { ok: distro != null, summary: distro != null ? launchercore.buildSummary(distro) : null }
    })

    ipcMain.handle(BRIDGE.DISTRO_REFRESH, async () => {
        const distro = await DistroAPI.refreshDistributionOrFallback()
        return { ok: distro != null, summary: distro != null ? launchercore.buildSummary(distro) : null }
    })

    /* statuses */
    ipcMain.handle(BRIDGE.SERVER_STATUS, async () => {
        try {
            const server = await serverById(ConfigManager.getSelectedServer())
            if(server == null){
                return { ok: false, status: null }
            }
            const status = await getServerStatus(47, server.hostname, server.port)
            return { ok: true, status }
        } catch(_err){
            return { ok: false, status: null }
        }
    })

    ipcMain.handle(BRIDGE.MOJANG_STATUS, async () => {
        const response = await MojangRestAPI.status()
        if(response.responseStatus === RestResponseStatus.SUCCESS){
            return { ok: true, statuses: response.data }
        }
        return { ok: true, statuses: MojangRestAPI.getDefaultStatuses() }
    })

    /* authentication */
    const authEnvelope = async (fn, args) => {
        try {
            const account = await fn(...args)
            return { ok: true, account, snapshot: launchercore.configSnapshot() }
        } catch(displayableError){
            return { ok: false, error: displayableError, snapshot: launchercore.configSnapshot() }
        }
    }

    ipcMain.handle(BRIDGE.AUTH_ADD_MOJANG, (_e, username, password) => {
        if(!boundedString(username, 256) || !boundedString(password, 256)){
            return invalid('Invalid credentials.')
        }
        return authEnvelope(AuthManager.addMojangAccount, [username, password])
    })

    ipcMain.handle(BRIDGE.AUTH_ADD_MICROSOFT, (_e, authCode) => {
        if(!boundedString(authCode, 4096)){
            return invalid('Invalid authorization code.')
        }
        return authEnvelope(AuthManager.addMicrosoftAccount, [authCode])
    })

    ipcMain.handle(BRIDGE.AUTH_REMOVE_MOJANG, (_e, uuid) => {
        if(!boundedString(uuid, 128)){
            return invalid('Invalid account id.')
        }
        return authEnvelope(AuthManager.removeMojangAccount, [uuid])
    })

    ipcMain.handle(BRIDGE.AUTH_REMOVE_MICROSOFT, (_e, uuid) => {
        if(!boundedString(uuid, 128)){
            return invalid('Invalid account id.')
        }
        return authEnvelope(AuthManager.removeMicrosoftAccount, [uuid])
    })

    // Validates and, when the tokens are stale, refreshes the selected
    // account. An account that cannot be refreshed is removed (the
    // renderer walks the user through re-adding it).
    ipcMain.handle(BRIDGE.AUTH_VALIDATE_SELECTED, async () => {
        const selected = ConfigManager.getSelectedAccount()
        let valid = false
        try {
            valid = await AuthManager.validateSelected()
        } catch(_err){
            valid = false
        }
        if(valid){
            return { ok: true, valid: true, account: selected, snapshot: launchercore.configSnapshot() }
        }
        if(selected != null){
            ConfigManager.removeAuthAccount(selected.uuid)
            ConfigManager.save()
        }
        return { ok: true, valid: false, account: selected, snapshot: launchercore.configSnapshot() }
    })

    /* java + launch */
    const javaOptionsShape = (o) => o != null && typeof o === 'object'
        && typeof o.suggestedMajor === 'number' && o.suggestedMajor >= 8 && o.suggestedMajor <= 64
        && (o.supported == null || boundedString(o.supported, 64))
        && (o.distribution == null || boundedString(o.distribution, 64))

    ipcMain.handle(BRIDGE.JAVA_SCAN, (_e, effectiveJavaOptions) => {
        if(!javaOptionsShape(effectiveJavaOptions)){
            return invalid('Invalid java options.')
        }
        return launchservice.javaScan(effectiveJavaOptions)
    })

    ipcMain.handle(BRIDGE.JAVA_DOWNLOAD, (_e, effectiveJavaOptions) => {
        if(!javaOptionsShape(effectiveJavaOptions)){
            return invalid('Invalid java options.')
        }
        return launchservice.javaDownload(effectiveJavaOptions)
    })

    ipcMain.handle(BRIDGE.JAVA_VALIDATE, (_e, execPath) => {
        if(!boundedString(execPath, 1024)){
            return { ok: true, details: null }
        }
        return launchservice.validateJvm(execPath).then(details => ({ ok: true, details }))
    })

    ipcMain.handle(BRIDGE.LAUNCH_PREPARE, () => launchservice.launchPrepare())

    ipcMain.handle(BRIDGE.LAUNCH, () => launchservice.launch())

    /* drop-in mods and shaderpacks */
    const MOD_NAME_REGEX = /^(.+(jar|zip|litemod))(?:\.(disabled))?$/
    const SHADER_NAME_REGEX = /^(.+)\.zip$/

    ipcMain.handle(BRIDGE.MODS_SCAN, async (_e, serverId) => {
        const server = await serverById(serverId)
        if(server == null){
            return invalid('Unknown server.')
        }
        const modsDir = path.join(ConfigManager.getInstanceDirectory(), server.rawServer.id, 'mods')
        DropinModUtil.validateDir(modsDir)
        const mods = DropinModUtil.scanForDropinMods(modsDir, server.rawServer.minecraftVersion)
            .map(mod => Object.assign({}, mod, { path: path.join(modsDir, mod.fullName) }))
        return { ok: true, modsDir, mods }
    })

    ipcMain.handle(BRIDGE.MODS_TOGGLE, async (_e, serverId, fullName, enable) => {
        const server = await serverById(serverId)
        if(server == null || typeof fullName !== 'string' || !MOD_NAME_REGEX.test(fullName) || fullName.includes('..') || typeof enable !== 'boolean'){
            return invalid('Invalid mod toggle request.')
        }
        const modsDir = path.join(ConfigManager.getInstanceDirectory(), server.rawServer.id, 'mods')
        try {
            await DropinModUtil.toggleDropinMod(modsDir, fullName, enable)
            return { ok: true }
        } catch(err){
            return { ok: false, error: { title: 'Unable to toggle the mod', desc: err.message || 'File system error.' } }
        }
    })

    // Move dropped files into the server's mods/shaderpacks folder. The
    // names are re-validated; the paths must be absolute existing files.
    ipcMain.handle(BRIDGE.MODS_ADD, async (_e, serverId, kind, names, srcPaths) => {
        const server = await serverById(serverId)
        if(server == null || (kind !== 'mod' && kind !== 'shader')){
            return invalid('Invalid add request.')
        }
        if(!Array.isArray(names) || !Array.isArray(srcPaths) || names.length !== srcPaths.length || names.length > 64){
            return invalid('Invalid add request.')
        }
        const nameOk = names.every(n => typeof n === 'string' && !n.includes('..') && !n.includes('/') && !n.includes('\\')
            && (kind === 'mod' ? MOD_NAME_REGEX.test(n) : SHADER_NAME_REGEX.test(n)))
        if(!nameOk){
            return invalid('Unsupported file name.')
        }
        const pathsOk = srcPaths.every(p => typeof p === 'string' && path.isAbsolute(p))
        if(!pathsOk){
            return invalid('Invalid file path.')
        }
        const instanceDir = ConfigManager.getInstanceDirectory()
        try {
            if(kind === 'mod'){
                const modsDir = path.join(instanceDir, server.rawServer.id, 'mods')
                DropinModUtil.addDropinMods(srcPaths, names, modsDir)
            } else {
                DropinModUtil.addShaderpacks(srcPaths, names, path.join(instanceDir, server.rawServer.id))
            }
            return { ok: true }
        } catch(err){
            return { ok: false, error: { title: 'Unable to add the file', desc: err.message || 'File system error.' } }
        }
    })

    ipcMain.handle(BRIDGE.SHADERS_SCAN, async (_e, serverId) => {
        const server = await serverById(serverId)
        if(server == null){
            return invalid('Unknown server.')
        }
        const instanceDir = path.join(ConfigManager.getInstanceDirectory(), server.rawServer.id)
        DropinModUtil.validateDir(path.join(instanceDir, 'shaderpacks'))
        const packs = DropinModUtil.scanForShaderpacks(instanceDir)
        const selected = DropinModUtil.getEnabledShaderpack(instanceDir)
        return { ok: true, instanceDir, packs, selected }
    })

    ipcMain.handle(BRIDGE.SHADER_SET, async (_e, serverId, pack) => {
        const server = await serverById(serverId)
        if(server == null || typeof pack !== 'string' || pack.length > 256 || pack.includes('..')){
            return invalid('Invalid shaderpack.')
        }
        const instanceDir = path.join(ConfigManager.getInstanceDirectory(), server.rawServer.id)
        const known = new Set(DropinModUtil.scanForShaderpacks(instanceDir).map(p => p.fullName))
        if(pack !== 'OFF' && !known.has(pack)){
            return invalid('Unknown shaderpack.')
        }
        DropinModUtil.setEnabledShaderpack(instanceDir, pack)
        return { ok: true }
    })

    /* crash report upload */
    // The renderer passes the fields the crash screen already parsed; the
    // fetch happens here (the renderer is sandboxed and CSP-bound, and the
    // policy deliberately does not include the API host). The size sanity
    // bounds below are deliberately loose: the crashreport module clamps
    // logTail/crashReport to the endpoint limits itself, so an oversized
    // but genuine log is truncated, never rejected.
    ipcMain.handle(BRIDGE.CRASH_REPORT_UPLOAD, (_e, fields) => {
        const f = fields
        const shapeOk = f != null && typeof f === 'object'
            && typeof f.cause === 'string' && f.cause.length > 0 && f.cause.length <= crashreport.LIMITS.cause
            && typeof f.logTail === 'string' && f.logTail.length <= 512 * 1024
            && (f.crashReport == null || (typeof f.crashReport === 'string' && f.crashReport.length <= 128 * 1024))
            && (f.mod == null || (typeof f.mod === 'string' && f.mod.length <= crashreport.LIMITS.mod))
            && (f.clientVersion == null || (typeof f.clientVersion === 'string' && f.clientVersion.length <= crashreport.LIMITS.clientVersion))
            && (f.mcVersion == null || (typeof f.mcVersion === 'string' && f.mcVersion.length <= crashreport.LIMITS.mcVersion))
        if(!shapeOk){
            return invalid('Invalid crash report payload.')
        }
        return crashreport.upload(fields, {
            meta: {
                launcher: 'ImperiumLauncher',
                launcherVersion: app.getVersion(),
                platform: process.platform
            }
        })
    })

    /* logging */
    ipcMain.handle(BRIDGE.LOG, (_e, name, level, parts) => {
        if(boundedString(name, 128) && boundedString(level, 16) && Array.isArray(parts)){
            const args = parts.slice(0, 16).map(p => {
                if(typeof p === 'string'){
                    return p.substring(0, 2000)
                }
                if(typeof p === 'number' || typeof p === 'boolean' || p == null){
                    return p
                }
                try {
                    return JSON.stringify(p).substring(0, 2000)
                } catch(_err){
                    return '[unserializable]'
                }
            })
            const tag = `[${name}]`
            if(level === 'error'){
                console.error(tag, ...args)
            } else if(level === 'warn'){
                console.warn(tag, ...args)
            } else {
                console.log(tag, ...args)
            }
        }
        return { ok: true }
    })
}

/**
 * Send the distribution-ready notification to the launcher window.
 *
 * @param {boolean} ok Whether the index loaded.
 */
exports.notifyDistroReady = function(ok){
    const win = getWindow()
    if(win != null){
        win.webContents.send(EVENTS.DISTRO_READY, ok)
    }
}

/**
 * Forward a launch event to the launcher window.
 *
 * @param {Object} payload The launch event payload.
 */
exports.emitLaunchEvent = function(payload){
    const win = getWindow()
    if(win != null){
        win.webContents.send(EVENTS.LAUNCH_EVENT, payload)
    }
}

/**
 * Notify the renderer that devtools were opened (scam warning).
 */
exports.notifyDevtoolsOpened = function(){
    const win = getWindow()
    if(win != null){
        win.webContents.send(EVENTS.DEVTOOLS_OPENED)
    }
}

exports.BRIDGE = BRIDGE
exports.EVENTS = EVENTS
