// Requirements
const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron')
const autoUpdater                       = require('electron-updater').autoUpdater
const ejse                              = require('ejs-electron')
const isDev                             = require('./app/assets/js/isdev')
const path                              = require('path')
const semver                            = require('semver')
const { pathToFileURL }                 = require('url')
const { AZURE_CLIENT_ID, AZURE_CLIENT_ID_CONFIGURED, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants')
const { isAllowedLink }             = require('./app/assets/js/newsSanitize')
const LangLoader                        = require('./app/assets/js/langloader')

// Romanica rebrand: the productName change moved userData from
// %APPDATA%\Imperium Launcher to %APPDATA%\Romanica Launcher. Carry the
// existing profile over before ANY module resolves config.json from it
// (configmanager computes its path at require time, so this must run
// ahead of the launcher core below).
require('./app/main/userdatamigration').init()

// Main-process launcher core (configuration, distribution index, launch
// pipeline) plus the validated renderer bridge.
const LauncherCore = require('./app/main/launchercore')
const LaunchService = require('./app/main/launchservice')
const BridgeIpc = require('./app/main/ipc')

// Setup Lang
LangLoader.setupLanguage()

// Setup auto updater.
function initAutoUpdater(event, data) {

    if(data){
        autoUpdater.allowPrerelease = true
    } else {
        // Defaults to true if application version contains prerelease components (e.g. 0.12.1-alpha.1)
        // autoUpdater.allowPrerelease = true
    }

    if(isDev){
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.updateConfigPath = path.join(__dirname, 'dev-app-update.yml')
    }
    if(process.platform === 'darwin'){
        autoUpdater.autoDownload = false
    }
    autoUpdater.on('update-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-available', info)
    })
    autoUpdater.on('update-downloaded', (info) => {
        event.sender.send('autoUpdateNotification', 'update-downloaded', info)
    })
    autoUpdater.on('update-not-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-not-available', info)
    })
    autoUpdater.on('checking-for-update', () => {
        event.sender.send('autoUpdateNotification', 'checking-for-update')
    })
    autoUpdater.on('error', (err) => {
        event.sender.send('autoUpdateNotification', 'realerror', err)
    })
}

// Open channel to listen for update actions.
ipcMain.on('autoUpdateAction', (event, arg, data) => {
    switch(arg){
        case 'initAutoUpdater':
            console.log('Initializing auto updater.')
            initAutoUpdater(event, data)
            event.sender.send('autoUpdateNotification', 'ready')
            break
        case 'checkForUpdate':
            autoUpdater.checkForUpdates()
                .catch(err => {
                    event.sender.send('autoUpdateNotification', 'realerror', err)
                })
            break
        case 'allowPrereleaseChange':
            if(!data){
                const preRelComp = semver.prerelease(app.getVersion())
                if(preRelComp != null && preRelComp.length > 0){
                    autoUpdater.allowPrerelease = true
                } else {
                    autoUpdater.allowPrerelease = data
                }
            } else {
                autoUpdater.allowPrerelease = data
            }
            break
        case 'installUpdateNow':
            autoUpdater.quitAndInstall()
            break
        default:
            console.log('Unknown argument', arg)
            break
    }
})

// Handle trash item. Only paths inside the launcher's own data
// directories are eligible; anything else is rejected before reaching
// the OS.
ipcMain.handle(SHELL_OPCODE.TRASH_ITEM, async (event, ...args) => {
    try {
        if(typeof args[0] !== 'string' || args[0].length === 0){
            throw new Error('Invalid path.')
        }
        const target = path.resolve(args[0])
        const roots = [
            LauncherCore.ConfigManager.getInstanceDirectory(),
            LauncherCore.ConfigManager.getCommonDirectory(),
            LauncherCore.ConfigManager.getDataDirectory()
        ].map(root => path.resolve(root))
        const contained = roots.some(root => target === root || target.startsWith(root + path.sep))
        if(!contained){
            throw new Error('Path is outside the launcher data directory.')
        }
        await shell.trashItem(target)
        return {
            result: true
        }
    } catch(error) {
        return {
            result: false,
            error: error
        }
    }
})

// Open an external link in the OS browser. The URL is validated in this
// process against the same policy the renderer applies; anything that is
// not an allowlisted https URL is rejected here.
ipcMain.handle(SHELL_OPCODE.OPEN_EXTERNAL, async (event, ...args) => {
    const url = args[0]
    if(!isAllowedLink(url)){
        return {
            result: false,
            error: 'URL is not allowed.'
        }
    }
    try {
        await shell.openExternal(url)
        return {
            result: true
        }
    } catch(error) {
        return {
            result: false,
            error: error
        }
    }
})

// Disable hardware acceleration.
// https://electronjs.org/docs/tutorial/offscreen-rendering
app.disableHardwareAcceleration()


const REDIRECT_URI_PREFIX = 'https://login.microsoftonline.com/common/oauth2/nativeclient?'

// Microsoft Auth Login
let msftAuthWindow
let msftAuthSuccess
let msftAuthViewSuccess
let msftAuthViewOnClose
ipcMain.on(MSFT_OPCODE.OPEN_LOGIN, (ipcEvent, ...arguments_) => {
    if (!AZURE_CLIENT_ID_CONFIGURED) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_CONFIGURED, arguments_[1])
        return
    }
    if (msftAuthWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN, msftAuthViewOnClose)
        return
    }
    msftAuthSuccess = false
    msftAuthViewSuccess = arguments_[0]
    msftAuthViewOnClose = arguments_[1]
    msftAuthWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLoginTitle'),
        backgroundColor: '#0f0e0c',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftAuthWindow.on('closed', () => {
        msftAuthWindow = undefined
    })

    msftAuthWindow.on('close', () => {
        if(!msftAuthSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED, msftAuthViewOnClose)
        }
    })

    msftAuthWindow.webContents.on('did-navigate', (_, uri) => {
        if (uri.startsWith(REDIRECT_URI_PREFIX)) {
            let queryMap = {}

            new URL(uri).searchParams.forEach((v, k) => {
                queryMap[k] = v
            })

            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.SUCCESS, queryMap, msftAuthViewSuccess)

            msftAuthSuccess = true
            msftAuthWindow.close()
            msftAuthWindow = null
        }
    })

    msftAuthWindow.removeMenu()
    msftAuthWindow.loadURL(`https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?prompt=select_account&client_id=${AZURE_CLIENT_ID}&response_type=code&scope=XboxLive.signin%20offline_access&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient`)
})

// Microsoft Auth Logout
let msftLogoutWindow
let msftLogoutSuccess
let msftLogoutSuccessSent
ipcMain.on(MSFT_OPCODE.OPEN_LOGOUT, (ipcEvent, uuid, isLastAccount) => {
    if (msftLogoutWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN)
        return
    }

    msftLogoutSuccess = false
    msftLogoutSuccessSent = false
    msftLogoutWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLogoutTitle'),
        backgroundColor: '#0f0e0c',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftLogoutWindow.on('closed', () => {
        msftLogoutWindow = undefined
    })

    msftLogoutWindow.on('close', () => {
        if(!msftLogoutSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED)
        } else if(!msftLogoutSuccessSent) {
            msftLogoutSuccessSent = true
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
        }
    })

    msftLogoutWindow.webContents.on('did-navigate', (_, uri) => {
        if(uri.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/logoutsession')) {
            msftLogoutSuccess = true
            setTimeout(() => {
                if(!msftLogoutSuccessSent) {
                    msftLogoutSuccessSent = true
                    ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
                }

                if(msftLogoutWindow) {
                    msftLogoutWindow.close()
                    msftLogoutWindow = null
                }
            }, 5000)
        }
    })

    msftLogoutWindow.removeMenu()
    msftLogoutWindow.loadURL('https://login.microsoftonline.com/common/oauth2/v2.0/logout')
})

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win

function createWindow() {

    win = new BrowserWindow({
        width: 980,
        height: 552,
        icon: getPlatformIcon('SealCircle'),
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'app', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        },
        backgroundColor: '#0f0e0c'
    })

    const data = {
        // 2026-10-22: fixed to the owner-selected Romanica key art (backgrounds/3.jpg).
        // To restore rotation, list the dir again and randomize.
        bkid: 3,
        lang: (str, placeHolders) => LangLoader.queryEJS(str, placeHolders)
    }
    Object.entries(data).forEach(([key, val]) => ejse.data(key, val))

    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString())

    // The launcher UI is a local document. In-window navigation away
    // from it is never expected, so it is blocked outright. External
    // destinations go through the validated openExternal path instead.
    win.webContents.on('will-navigate', (event, url) => {
        const pageUrl = pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString()
        if(url !== pageUrl){
            event.preventDefault()
            if(isAllowedLink(url)){
                shell.openExternal(url).catch(() => {})
            }
        }
    })

    // The launcher never opens child windows; requests to do so are denied.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if(isAllowedLink(url)){
            shell.openExternal(url).catch(() => {})
        }
        return { action: 'deny' }
    })

    // Scam warning when the console is opened (displayed by the renderer).
    win.webContents.on('devtools-opened', () => {
        BridgeIpc.notifyDevtoolsOpened()
    })

    // The renderer scripts subscribe to the distribution-ready event once
    // the page has loaded; deliver pending notifications at that point.
    // (Every load, so a dev reload also receives the cached state.)
    win.webContents.on('did-finish-load', () => {
        pageLoaded = true
        if(distroState !== null){
            BridgeIpc.notifyDistroReady(distroState)
        }
    })

    win.on('closed', () => {
        win = null
        pageLoaded = false
    })

    /*win.once('ready-to-show', () => {
        win.show()
    })*/

    win.removeMenu()

    win.resizable = true
}

/* Startup sequence formerly owned by the renderer preloader. */

LauncherCore.init()
LauncherCore.cleanTempNatives()
LaunchService.init(LauncherCore, BridgeIpc.emitLaunchEvent)
BridgeIpc.register(() => win)

let distroState = null // null = loading, true = ok, false = fatal
let pageLoaded = false

/**
 * Load the distribution index and sync stored configuration against it,
 * then notify the renderer when it is ready.
 */
async function loadStartupDistribution(){
    try {
        const data = await LauncherCore.loadDistribution()
        LauncherCore.syncConfigurationWithDistribution(data)
        distroState = data != null
    } catch(err){
        console.error('[Startup] Unable to load distribution index.', err)
        distroState = false
    }
    if(pageLoaded && win != null){
        BridgeIpc.notifyDistroReady(distroState)
    }
}

function createMenu() {

    if(process.platform === 'darwin') {

        // Extend default included application menu to continue support for quit keyboard shortcut
        let applicationSubMenu = {
            label: 'Application',
            submenu: [{
                label: 'About Application',
                selector: 'orderFrontStandardAboutPanel:'
            }, {
                type: 'separator'
            }, {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: () => {
                    app.quit()
                }
            }]
        }

        // New edit menu adds support for text-editing keyboard shortcuts
        let editSubMenu = {
            label: 'Edit',
            submenu: [{
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            }, {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            }, {
                type: 'separator'
            }, {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            }, {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            }, {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            }, {
                type: 'separator'
            }, {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            }]
        }

        // Bundle submenus into a single template and build a menu object with it
        let menuTemplate = [applicationSubMenu, editSubMenu]
        let menuObject = Menu.buildFromTemplate(menuTemplate)

        // Assign the application menu
        Menu.setApplicationMenu(menuObject)

    }

}

function getPlatformIcon(filename){
    let ext
    switch(process.platform) {
        case 'win32':
            ext = 'ico'
            break
        case 'darwin':
        case 'linux':
        default:
            ext = 'png'
            break
    }

    return path.join(__dirname, 'app', 'assets', 'images', `${filename}.${ext}`)
}

if(process.env.IMPERIUM_SMOKE_LAUNCH === '1'){
    // Headless CI smoke run (issue #5): the smoke driver pre-seeded an
    // offline account and watches the game log, so no launcher window is
    // created and no renderer can interfere with the launch.
    app.on('ready', () => {
        require('./app/main/smokelaunch').run(LauncherCore, LaunchService)
    })
} else {
    app.on('ready', createWindow)
    app.on('ready', createMenu)
}
app.on('ready', loadStartupDistribution)

app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
        createWindow()
    }
})
