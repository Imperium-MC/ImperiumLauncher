/**
 * preload.js — the only link between the sandboxed renderer and the main
 * process.
 *
 * The renderer has no node integration and runs isolated; everything it
 * can do is a named function on the exposed `imperium` object, backed by
 * ipcRenderer.invoke with main-side argument validation. There is
 * deliberately no generic evaluate/require/file passthrough.
 *
 * `env` is hydrated with a single synchronous round trip so page scripts
 * can read configuration and language strings at parse time, exactly like
 * the node-integrated scripts they replace.
 */
const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron')

// Disable zoom, needed for darwin.
try {
    webFrame.setZoomLevel(0)
    webFrame.setVisualZoomLevelLimits(1, 1)
} catch(_err){
    // Visual zoom limits are best-effort; never block the bridge.
}

// Channel names (mirrored in app/main/ipc.js and index.js).
const CH = {
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

// Pre-existing channels shared with index.js.
const SHELL = {
    TRASH_ITEM: 'TRASH_ITEM',
    OPEN_EXTERNAL: 'SHELL_OPEN_EXTERNAL'
}
const MSFT = {
    OPEN_LOGIN: 'MSFT_AUTH_OPEN_LOGIN',
    OPEN_LOGOUT: 'MSFT_AUTH_OPEN_LOGOUT',
    REPLY_LOGIN: 'MSFT_AUTH_REPLY_LOGIN',
    REPLY_LOGOUT: 'MSFT_AUTH_REPLY_LOGOUT'
}

// One synchronous round trip at load time.
const env = ipcRenderer.sendSync(CH.BOOTSTRAP)

contextBridge.exposeInMainWorld('imperium', {

    /* Environment hydrated at preload time (plain data, no functions). */
    env,

    /* App info */
    appVersion: () => env.version,

    /* Window operations */
    setProgressBar: (value) => ipcRenderer.invoke(CH.SET_PROGRESS_BAR, value),
    windowClose: () => ipcRenderer.invoke(CH.WINDOW_CLOSE),
    windowMinimize: () => ipcRenderer.invoke(CH.WINDOW_MINIMIZE),
    windowToggleMaximize: () => ipcRenderer.invoke(CH.WINDOW_TOGGLE_MAXIMIZE),
    toggleDevTools: () => ipcRenderer.invoke(CH.TOGGLE_DEVTOOLS),

    /* Shell */
    clipboardWriteText: (text) => ipcRenderer.invoke(CH.CLIPBOARD_WRITE_TEXT, text),
    openExternal: (url) => ipcRenderer.invoke(SHELL.OPEN_EXTERNAL, url),
    trashItem: (target) => ipcRenderer.invoke(SHELL.TRASH_ITEM, target),
    openPath: (target) => ipcRenderer.invoke(CH.OPEN_PATH, target),
    pathForFile: (file) => webUtils.getPathForFile(file),

    /* Dialogs */
    showOpenDialog: (options) => ipcRenderer.invoke(CH.SHOW_OPEN_DIALOG, options),

    /* Configuration mirror */
    configApply: (op, args) => ipcRenderer.invoke(CH.CONFIG_APPLY, op, args),
    configSave: () => ipcRenderer.invoke(CH.CONFIG_SAVE),
    configRefresh: () => ipcRenderer.invoke(CH.CONFIG_REFRESH),

    /* Distribution */
    distroSummary: () => ipcRenderer.invoke(CH.DISTRO_SUMMARY),
    distroRefresh: () => ipcRenderer.invoke(CH.DISTRO_REFRESH),

    /* Statuses */
    serverStatus: () => ipcRenderer.invoke(CH.SERVER_STATUS),
    mojangStatus: () => ipcRenderer.invoke(CH.MOJANG_STATUS),

    /* Authentication */
    authAddMojang: (username, password) => ipcRenderer.invoke(CH.AUTH_ADD_MOJANG, username, password),
    authAddMicrosoft: (authCode) => ipcRenderer.invoke(CH.AUTH_ADD_MICROSOFT, authCode),
    authRemoveMojang: (uuid) => ipcRenderer.invoke(CH.AUTH_REMOVE_MOJANG, uuid),
    authRemoveMicrosoft: (uuid) => ipcRenderer.invoke(CH.AUTH_REMOVE_MICROSOFT, uuid),
    authValidateSelected: () => ipcRenderer.invoke(CH.AUTH_VALIDATE_SELECTED),

    /* Java + launch */
    javaScan: (effectiveJavaOptions) => ipcRenderer.invoke(CH.JAVA_SCAN, effectiveJavaOptions),
    javaDownload: (effectiveJavaOptions) => ipcRenderer.invoke(CH.JAVA_DOWNLOAD, effectiveJavaOptions),
    javaValidate: (execPath) => ipcRenderer.invoke(CH.JAVA_VALIDATE, execPath),
    launchPrepare: () => ipcRenderer.invoke(CH.LAUNCH_PREPARE),
    launch: () => ipcRenderer.invoke(CH.LAUNCH),

    /* Drop-in mods and shaderpacks */
    modsScan: (serverId) => ipcRenderer.invoke(CH.MODS_SCAN, serverId),
    modsToggle: (serverId, fullName, enable) => ipcRenderer.invoke(CH.MODS_TOGGLE, serverId, fullName, enable),
    modsAdd: (serverId, kind, names, paths) => ipcRenderer.invoke(CH.MODS_ADD, serverId, kind, names, paths),
    shadersScan: (serverId) => ipcRenderer.invoke(CH.SHADERS_SCAN, serverId),
    shaderSet: (serverId, pack) => ipcRenderer.invoke(CH.SHADER_SET, serverId, pack),

    /* Logging */
    log: (name, level, parts) => ipcRenderer.invoke(CH.LOG, name, level, parts),

    /* Crash report upload (the POST runs in the main process) */
    crashReportUpload: (fields) => ipcRenderer.invoke(CH.CRASH_REPORT_UPLOAD, fields),

    /* Auto update (existing channels, kept as-is) */
    autoUpdateAction: (arg, data) => ipcRenderer.send('autoUpdateAction', arg, data),
    onAutoUpdateNotification: (callback) => {
        ipcRenderer.on('autoUpdateNotification', (_event, arg, info) => callback(arg, info))
    },

    /* Microsoft login windows (existing channels, kept as-is) */
    msftOpenLogin: (successView, closeView) => ipcRenderer.send(MSFT.OPEN_LOGIN, successView, closeView),
    msftOpenLogout: (uuid, isLastAccount) => ipcRenderer.send(MSFT.OPEN_LOGOUT, uuid, isLastAccount),
    onMsftReplyLogin: (callback) => {
        ipcRenderer.on(MSFT.REPLY_LOGIN, (_event, ...args) => callback(...args))
    },
    onMsftReplyLogout: (callback) => {
        ipcRenderer.on(MSFT.REPLY_LOGOUT, (_event, ...args) => callback(...args))
    },

    /* Launcher events */
    onDistroReady: (callback) => {
        ipcRenderer.on('distributionIndexDone', (_event, ok) => callback(ok))
    },
    onDevtoolsOpened: (callback) => {
        ipcRenderer.on('devtoolsOpened', () => callback())
    },
    onLaunchEvent: (callback) => {
        ipcRenderer.on('launchEvent', (_event, payload) => callback(payload))
    },
    onCrashReport: (callback) => {
        ipcRenderer.on('crashReport', (_event, payload) => callback(payload))
    }
})
