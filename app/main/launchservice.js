/**
 * launchservice.js — the launch pipeline, main-process side.
 *
 * Ported from the renderer's landing.js (dlAsync / asyncSystemScan /
 * downloadJava) when the renderer lost node access. The UI feedback that
 * used to be direct DOM calls is emitted as launch events which the
 * renderer translates into the same progress UI. Language strings are
 * resolved here so raw pipeline text never has to be interpreted by the
 * renderer beyond plain display.
 */
const { app } = require('electron')
const { LoggerUtil }        = require('helios-core')
const { validateLocalFile } = require('helios-core/common')
const {
    DistributionIndexProcessor,
    MojangIndexProcessor,
    downloadFile
}                            = require('helios-core/dl')
const {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    latestOpenJDK,
    extractJdk
}                            = require('helios-core/java')

const { ImperiumRepair } = require('../assets/js/assetdl')
const { reapStaleManagedModules } = require('../assets/js/managedmodcleanup')
const ProcessBuilder     = require('../assets/js/processbuilder')
const DiscordWrapper     = require('../assets/js/discordwrapper')
const CrashScreen        = require('../assets/js/crashscreen')

const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')
const loggerLanding     = LoggerUtil.getLogger('Landing')

// Keep reference to the active game process (owned here now).
let proc = null
// Is DiscordRPC enabled
let hasRPC = false
// Set while a launch() is running; the renderer's hidden button is not a
// guard against a double click or an overlapping Retry All.
let launching = false

let emit = () => {}
let core = null

/**
 * Wire the service dependencies.
 *
 * @param {Object} launchercore The launcher core module.
 * @param {function(Object): void} emitFn The launch event emitter.
 */
exports.init = function(launchercore, emitFn){
    core = launchercore
    emit = emitFn
    CrashScreen.setDispatch((payload) => emitFn({ kind: 'crashReport', payload }))
}

/**
 * Resolve the language string for a key.
 */
function L(key, placeholders){
    return core.LangLoader.queryJS(key, placeholders)
}

// Joined server / launch detection regexes (unchanged from landing.js).
const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+)$/
const MIN_LINGER = 5000

/**
 * First stage of the launch button flow: resolve the selected server and
 * decide whether the stored Java executable is usable, or a system scan
 * is required. The renderer uses the result to pick between launching
 * directly and the Java scan/download overlay flow.
 *
 * @returns {Promise.<Object>} {status: 'ready'} | {status: 'scan', effectiveJavaOptions}
 */
exports.launchPrepare = async function(){
    const distro = await core.DistroAPI.getDistribution()
    const server = distro.getServerById(core.ConfigManager.getSelectedServer())
    if(server == null){
        return {
            status: 'error',
            error: {
                title: L('landing.launch.failureTitle'),
                desc: L('landing.launch.failureText')
            }
        }
    }

    const jExe = core.ConfigManager.getJavaExecutable(core.ConfigManager.getSelectedServer())
    if(jExe == null){
        return { status: 'scan', effectiveJavaOptions: server.effectiveJavaOptions }
    }

    const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
    if(details != null){
        return { status: 'ready' }
    }
    return { status: 'scan', effectiveJavaOptions: server.effectiveJavaOptions }
}

/**
 * Scan the system for a valid Java installation. When one is found it is
 * stored as the selected server's executable.
 *
 * @param {Object} effectiveJavaOptions The server's effective java options.
 * @returns {Promise.<Object>} {found: true, javaExec} | {found: false}
 */
exports.javaScan = async function(effectiveJavaOptions){
    emit({ kind: 'details', text: L('landing.systemScan.checking') })
    emit({ kind: 'loading', value: true })
    emit({ kind: 'progress', percent: 0 })

    const jvmDetails = await discoverBestJvmInstallation(
        core.ConfigManager.getDataDirectory(),
        effectiveJavaOptions.supported
    )

    if(jvmDetails == null){
        emit({ kind: 'loading', value: false })
        return { found: false }
    }

    const javaExec = javaExecFromRoot(jvmDetails.path)
    core.ConfigManager.setJavaExecutable(core.ConfigManager.getSelectedServer(), javaExec)
    core.ConfigManager.save()
    return { found: true, javaExec }
}

/**
 * Download and extract a JDK for the server's suggested major version.
 * Progress is reported through the launch events; the returned promise
 * settles when the JDK is installed and stored in the config.
 *
 * @param {Object} effectiveJavaOptions The server's effective java options.
 * @returns {Promise.<Object>} {ok: true, javaExec} | {ok: false, title, desc}
 */
exports.javaDownload = async function(effectiveJavaOptions){
    let asset
    try {
        asset = await latestOpenJDK(
            effectiveJavaOptions.suggestedMajor,
            core.ConfigManager.getDataDirectory(),
            effectiveJavaOptions.distribution
        )
    } catch(err){
        loggerLanding.error('Unhandled error in Java Download', err)
    }
    if(asset == null){
        return {
            ok: false,
            title: L('landing.systemScan.javaDownloadFailureTitle'),
            desc: L('landing.systemScan.javaDownloadFailureText')
        }
    }

    let received = 0
    try {
        await downloadFile(asset.url, asset.path, ({ transferred }) => {
            received = transferred
            emit({ kind: 'downloadProgress', percent: Math.trunc((transferred/asset.size)*100) })
        })
    } catch(err){
        loggerLanding.error('Unhandled error in Java Download', err)
        return {
            ok: false,
            title: L('landing.systemScan.javaDownloadFailureTitle'),
            desc: L('landing.systemScan.javaDownloadFailureText')
        }
    }
    emit({ kind: 'downloadProgress', percent: 100 })

    if(received != asset.size){
        loggerLanding.warn(`Java Download: Expected ${asset.size} bytes but received ${received}`)
        try {
            if(!await validateLocalFile(asset.path, asset.algo, asset.hash)){
                loggerLaunchSuite.error(`Hashes do not match, ${asset.id} may be corrupted.`)
                return {
                    ok: false,
                    title: L('landing.systemScan.javaDownloadFailureTitle'),
                    desc: L('landing.downloadJava.javaDownloadCorruptedError')
                }
            }
        } catch(err){
            loggerLanding.error('Unhandled error in Java Download', err)
            return {
                ok: false,
                title: L('landing.systemScan.javaDownloadFailureTitle'),
                desc: L('landing.systemScan.javaDownloadFailureText')
            }
        }
    }

    // Show installing progress bar.
    emit({ kind: 'javaIndeterminate' })

    const eLStr = L('landing.downloadJava.extractingJava')
    let dotStr = ''
    emit({ kind: 'details', text: eLStr })
    const extractListener = setInterval(() => {
        if(dotStr.length >= 3){
            dotStr = ''
        } else {
            dotStr += '.'
        }
        emit({ kind: 'details', text: eLStr + dotStr })
    }, 750)

    let newJavaExec
    try {
        newJavaExec = await extractJdk(asset.path)
    } catch(err){
        loggerLanding.error('Unhandled error during Java extraction.', err)
        return {
            ok: false,
            title: L('landing.systemScan.javaDownloadFailureTitle'),
            desc: L('landing.systemScan.javaDownloadFailureText')
        }
    } finally {
        clearInterval(extractListener)
    }

    // Extraction complete, remove the loading from the OS progress bar.
    emit({ kind: 'javaClear' })

    core.ConfigManager.setJavaExecutable(core.ConfigManager.getSelectedServer(), newJavaExec)
    core.ConfigManager.save()
    emit({ kind: 'details', text: L('landing.downloadJava.javaInstalled') })

    return { ok: true, javaExec: newJavaExec }
}

/**
 * Validate a user-provided Java executable path against the selected
 * server's supported range.
 *
 * @param {string} execPath The executable path.
 * @returns {Promise.<Object|null>} JVM details, or null when invalid.
 */
exports.validateJvm = async function(execPath){
    const distro = await core.DistroAPI.getDistribution()
    const server = distro.getServerById(core.ConfigManager.getSelectedServer())
    if(server == null){
        return null
    }
    return await validateSelectedJvm(ensureJavaDirIsRoot(execPath), server.effectiveJavaOptions.supported)
}

/**
 * The full launch pipeline (former dlAsync). Reports progress through
 * launch events; resolves with {ok} when the game process has been built.
 *
 * @param {boolean} login Whether to launch the game after syncing.
 * @returns {Promise.<Object>} {ok: true} on a successful build, otherwise
 * the failure has already been emitted as a failure event.
 */
exports.launch = async function(login = true){
    if(launching){
        loggerLaunchSuite.warn('Launch requested while another launch is in progress, ignoring.')
        return { ok: false, busy: true }
    }
    launching = true
    try {
        return await runLaunch(login)
    } finally {
        launching = false
    }
}

/**
 * @returns {boolean} Whether a game process started by this launcher is
 * still running.
 */
exports.isGameRunning = function(){
    return proc != null
}

async function runLaunch(login){
    emit({ kind: 'details', text: L('landing.dlAsync.loadingServerInfo') })

    let distro
    try {
        distro = await core.DistroAPI.refreshDistributionOrFallback()
    } catch(err){
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        emit({ kind: 'failure', title: L('landing.dlAsync.fatalError'), desc: L('landing.dlAsync.unableToLoadDistributionIndex') })
        emit({ kind: 'loading', value: false })
        return { ok: false }
    }

    // The renderer refreshes its server selection and the news panel off
    // the refreshed index.
    emit({ kind: 'distroRefreshed', summary: core.buildSummary(distro) })

    const serv = distro.getServerById(core.ConfigManager.getSelectedServer())

    if(login && core.ConfigManager.getSelectedAccount() == null){
        loggerLanding.error('You must be logged into an account.')
        emit({ kind: 'loading', value: false })
        return { ok: false }
    }

    emit({ kind: 'details', text: L('landing.dlAsync.pleaseWait') })
    emit({ kind: 'loading', value: true })
    emit({ kind: 'progress', percent: 0 })

    const repairModule = new ImperiumRepair(
        core.ConfigManager.getCommonDirectory(),
        core.ConfigManager.getInstanceDirectory(),
        core.ConfigManager.getLauncherDirectory(),
        core.ConfigManager.getSelectedServer(),
        core.DistroAPI.isDevMode()
    )

    // Tracks whether a failure of this sync has already been surfaced to
    // the user. The receiver child exits non-zero after reporting an
    // error, and the 'close' handler must not overwrite the actionable
    // failure overlay with a generic one.
    const syncState = {
        completed: false,
        failureShown: false
    }

    repairModule.spawnReceiver()

    repairModule.childProcess.on('error', (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        syncState.failureShown = true
        emit({ kind: 'clearFileProgress' })
        emit({ kind: 'failure', title: L('landing.dlAsync.errorDuringLaunchTitle'), desc: err.message || L('landing.dlAsync.errorDuringLaunchText') })
    })
    repairModule.childProcess.on('close', (code, _signal) => {
        if(code !== 0 && !syncState.completed && !syncState.failureShown){
            loggerLaunchSuite.error(`Asset download module exited with code ${code}, assuming error.`)
            syncState.failureShown = true
            emit({ kind: 'clearFileProgress' })
            emit({ kind: 'failure', title: L('landing.dlAsync.errorDuringLaunchTitle'), desc: L('landing.dlAsync.seeConsoleForDetails') })
        }
    })

    loggerLaunchSuite.info('Validating files.')
    emit({ kind: 'details', text: L('landing.dlAsync.validatingFileIntegrity') })
    let invalidFileCount = 0
    try {
        invalidFileCount = await repairModule.verifyFiles(percent => {
            emit({ kind: 'progress', percent })
        })
        emit({ kind: 'progress', percent: 100 })
    } catch (err){
        loggerLaunchSuite.error('Error during file validation.')
        syncState.failureShown = true
        emit({ kind: 'failure', title: L('landing.dlAsync.errorDuringFileVerificationTitle'), desc: err.displayable || L('landing.dlAsync.seeConsoleForDetails') })
        return { ok: false }
    }

    if(invalidFileCount > 0){
        loggerLaunchSuite.info('Downloading files.')
        emit({ kind: 'details', text: L('landing.dlAsync.downloadingFiles') })
        emit({ kind: 'progress', percent: 0 })
        emit({ kind: 'clearFileProgress' })
        try {
            await repairModule.download(
                percent => {
                    emit({ kind: 'downloadProgress', percent })
                },
                file => {
                    emit({ kind: 'fileProgress', text: L('landing.dlAsync.downloadingFile', {
                        index: file.index,
                        count: file.count,
                        file: file.name,
                        percent: file.percent != null ? file.percent : 0
                    })})
                },
                retry => {
                    emit({ kind: 'fileRetry', text: L('landing.dlAsync.retryingFile', {
                        attempt: retry.attempt,
                        max: retry.max,
                        file: retry.name
                    })})
                }
            )
            emit({ kind: 'downloadProgress', percent: 100 })
        } catch(err){
            loggerLaunchSuite.error('Error during file download.')
            syncState.failureShown = true
            emit({ kind: 'clearFileProgress' })
            emit({ kind: 'downloadFailure', title: L('landing.dlAsync.errorDuringFileDownloadTitle'), desc: err.displayable || L('landing.dlAsync.seeConsoleForDetails') })
            return { ok: false }
        }
    } else {
        loggerLaunchSuite.info('No invalid files, skipping download.')
    }

    syncState.completed = true
    emit({ kind: 'clearFileProgress' })
    emit({ kind: 'javaClear' })

    repairModule.destroyReceiver()

    // Issue #14: the sync just verified every referenced mod in place, so
    // launcher-managed versions that fell out of the distribution can be
    // reaped safely. Cleanup must never take the launch down with it.
    try {
        const { removed } = await reapStaleManagedModules(
            distro,
            core.ConfigManager.getCommonDirectory()
        )
        if(removed.length > 0){
            loggerLaunchSuite.info(`Removed ${removed.length} stale launcher-managed mod file(s) no longer in the distribution.`)
        }
    } catch(err) {
        loggerLaunchSuite.warn('Stale managed-mod cleanup failed; the launch continues.', err)
    }

    emit({ kind: 'details', text: L('landing.dlAsync.preparingToLaunch') })

    const mojangIndexProcessor = new MojangIndexProcessor(
        core.ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(
        core.ConfigManager.getCommonDirectory(),
        distro,
        serv.rawServer.id
    )

    const modLoaderData = await distributionIndexProcessor.loadModLoaderVersionJson(serv)
    const versionData = await mojangIndexProcessor.getVersionJson()

    if(login){
        const authUser = core.ConfigManager.getSelectedAccount()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
        const pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, app.getVersion())
        emit({ kind: 'details', text: L('landing.dlAsync.launchingGame') })

        const escapedName = authUser.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const SERVER_JOINED_REGEX = new RegExp(`\\[.+\\]: \\[CHAT\\] ${escapedName} joined the game`)

        let child = null
        const onLoadComplete = () => {
            emit({ kind: 'gameLaunched' })
            if(hasRPC){
                DiscordWrapper.updateDetails(L('landing.discord.loading'))
                child.stdout.on('data', gameStateChange)
            }
            child.stdout.removeListener('data', tempListener)
            child.stderr.removeListener('data', gameErrorListener)
        }
        const start = Date.now()

        // Attach a temporary listener to the client output. Will wait for
        // a certain bit of text meaning that the client application has
        // started, and we can hide the progress bar stuff.
        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(data.trim())){
                const diff = Date.now()-start
                if(diff < MIN_LINGER){
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }

        // Listener for Discord RPC.
        const gameStateChange = function(data){
            data = data.trim()
            if(SERVER_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(L('landing.discord.joined'))
            } else if(GAME_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(L('landing.discord.joining'))
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                emit({ kind: 'failure', title: L('landing.dlAsync.errorDuringLaunchTitle'), desc: L('landing.dlAsync.launchWrapperNotDownloaded') })
            }
        }

        try {
            // Build Minecraft process.
            child = pb.build()
            proc = child

            // Bind listeners to stdout.
            child.stdout.on('data', tempListener)
            child.stderr.on('data', gameErrorListener)

            emit({ kind: 'details', text: L('landing.dlAsync.doneEnjoyServer') })

            // Init Discord Hook
            if(distro.rawDistribution.discord != null && serv.rawServer.discord != null){
                DiscordWrapper.initRPC(distro.rawDistribution.discord, serv.rawServer.discord)
                hasRPC = true
            }
            child.on('close', (_code, _signal) => {
                if(hasRPC){
                    loggerLaunchSuite.info('Shutting down Discord Rich Presence..')
                    DiscordWrapper.shutdownRPC()
                    hasRPC = false
                }
                if(proc === child){
                    proc = null
                }
            })

        } catch(err){
            loggerLaunchSuite.error('Error during launch', err)
            emit({ kind: 'failure', title: L('landing.dlAsync.errorDuringLaunchTitle'), desc: L('landing.dlAsync.checkConsoleForDetails') })
            return { ok: false }
        }
    }

    return { ok: true }
}
