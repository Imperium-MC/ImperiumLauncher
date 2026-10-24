/**
 * launchercore.js — main-process home of the launcher's core state.
 *
 * The renderer runs sandboxed with no node access, so everything that
 * touches the file system, the network or child processes lives here:
 * configuration, the distribution index, language strings and the startup
 * tasks the renderer preload used to perform.
 */
const { app } = require('electron')
const fs   = require('fs-extra')
const os   = require('os')
const path = require('path')

const ConfigManager = require('../assets/js/configmanager')
const { DistroAPI }  = require('../assets/js/distromanager')
const LangLoader     = require('../assets/js/langloader')
const isDev          = require('../assets/js/isdev')
const { Type }       = require('helios-distribution-types')

let initialized = false

/**
 * Load the configuration and prepare the distribution API. Runs once at
 * app start, before the window is created.
 */
exports.init = function(){
    if(initialized){
        return
    }
    initialized = true
    ConfigManager.load()

    // Distribution API directory injection (formerly done by the renderer
    // preloader, which had to run before the first getDistribution call).
    DistroAPI['commonDir']   = ConfigManager.getCommonDirectory()
    DistroAPI['instanceDir'] = ConfigManager.getInstanceDirectory()
}

/**
 * Clean up the temp natives directory in case a previous launch ended
 * unexpectedly (formerly the renderer preloader's cleanup).
 */
exports.cleanTempNatives = function(){
    fs.remove(path.join(os.tmpdir(), ConfigManager.getTempNativeFolder()), (err) => {
        if(err){
            console.warn('[LauncherCore] Error while cleaning natives directory', err)
        }
    })
}

/**
 * Load (and cache) the distribution index, resolving the selected server
 * if it has not been set yet. Mirrors the old renderer preloader logic.
 *
 * @returns {Promise<Object>} The loaded HeliosDistribution.
 */
exports.loadDistribution = async function(){
    const data = await DistroAPI.getDistribution()
    if(data != null){
        if(ConfigManager.getSelectedServer() == null || data.getServerById(ConfigManager.getSelectedServer()) == null){
            console.log('[LauncherCore] Determining default selected server..')
            ConfigManager.setSelectedServer(data.getMainServer().rawServer.id)
            ConfigManager.save()
        }
    }
    return data
}

/**
 * Sync the stored mod configurations with the current distribution index
 * and ensure java settings exist (ported from the renderer's uibinder so
 * it runs beside the index it synchronizes with).
 *
 * @param {Object} data A HeliosDistribution instance.
 */
exports.syncConfigurationWithDistribution = function(data){
    const syncedCfgs = []

    const scanOptionalSubModules = (mdls, origin) => {
        if(mdls != null){
            const mods = {}
            for(const mdl of mdls){
                const type = mdl.rawModule.type
                if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                    if(!mdl.getRequired().value){
                        mods[mdl.getVersionlessMavenIdentifier()] = scanOptionalSubModules(mdl.subModules, mdl)
                    } else if(mdl.hasSubModules()){
                        const v = scanOptionalSubModules(mdl.subModules, mdl)
                        if(typeof v === 'object'){
                            mods[mdl.getVersionlessMavenIdentifier()] = v
                        }
                    }
                }
            }
            if(Object.keys(mods).length > 0){
                const ret = { mods }
                if(!origin.getRequired().value){
                    ret.value = origin.getRequired().def
                }
                return ret
            }
        }
        return origin.getRequired().def
    }

    const mergeModConfiguration = (o, n, nReq = false) => {
        if(typeof o === 'boolean'){
            if(typeof n === 'boolean') return o
            else if(typeof n === 'object'){
                if(!nReq){
                    n.value = o
                }
                return n
            }
        } else if(typeof o === 'object'){
            if(typeof n === 'boolean') return typeof o.value !== 'undefined' ? o.value : true
            else if(typeof n === 'object'){
                if(!nReq){
                    n.value = typeof o.value !== 'undefined' ? o.value : true
                }
                const newMods = Object.keys(n.mods)
                for(let i=0; i<newMods.length; i++){
                    const mod = newMods[i]
                    if(o.mods[mod] != null){
                        n.mods[mod] = mergeModConfiguration(o.mods[mod], n.mods[mod])
                    }
                }
                return n
            }
        }
        return n
    }

    for(const serv of data.servers){
        const id = serv.rawServer.id
        const mdls = serv.modules
        const cfg = ConfigManager.getModConfiguration(id)
        const mods = {}

        for(const mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                if(!mdl.getRequired().value){
                    const mdlID = mdl.getVersionlessMavenIdentifier()
                    mods[mdlID] = cfg != null && cfg.mods != null && cfg.mods[mdlID] != null
                        ? mergeModConfiguration(cfg.mods[mdlID], scanOptionalSubModules(mdl.subModules, mdl), false)
                        : scanOptionalSubModules(mdl.subModules, mdl)
                } else if(mdl.subModules.length > 0){
                    const mdlID = mdl.getVersionlessMavenIdentifier()
                    const v = scanOptionalSubModules(mdl.subModules, mdl)
                    if(typeof v === 'object'){
                        mods[mdlID] = cfg != null && cfg.mods != null && cfg.mods[mdlID] != null
                            ? mergeModConfiguration(cfg.mods[mdlID], v, true)
                            : v
                    }
                }
            }
        }

        syncedCfgs.push({ id, mods })
    }

    ConfigManager.setModConfigurations(syncedCfgs)

    for(const serv of data.servers){
        ConfigManager.ensureJavaConfig(serv.rawServer.id, serv.effectiveJavaOptions, serv.rawServer.javaOptions?.ram)
    }

    ConfigManager.save()
}

/**
 * Build the serializable projection of a distribution the renderer UI
 * consumes. The renderer attaches the few helper methods it needs on top
 * of this plain tree.
 *
 * @param {Object} distro A HeliosDistribution instance.
 * @returns {Object} JSON-safe distribution summary.
 */
exports.buildSummary = function(distro){
    const summarizeModule = (mdl) => ({
        id: mdl.rawModule.id,
        name: mdl.rawModule.name,
        type: mdl.rawModule.type,
        required: mdl.getRequired(),
        versionlessId: mdl.hasMavenComponents() ? mdl.getVersionlessMavenIdentifier() : mdl.rawModule.id,
        version: mdl.mavenComponents != null ? mdl.mavenComponents.version : null,
        subModules: mdl.subModules.map(summarizeModule)
    })

    const summarizeServer = (serv) => ({
        rawServer: {
            id: serv.rawServer.id,
            name: serv.rawServer.name,
            description: serv.rawServer.description,
            version: serv.rawServer.version,
            minecraftVersion: serv.rawServer.minecraftVersion,
            address: serv.rawServer.address,
            mainServer: serv.rawServer.mainServer,
            icon: serv.rawServer.icon,
            discord: serv.rawServer.discord,
            javaOptions: serv.rawServer.javaOptions
        },
        hostname: serv.hostname,
        port: serv.port,
        effectiveJavaOptions: serv.effectiveJavaOptions,
        modules: serv.modules.map(summarizeModule)
    })

    return {
        rss: distro.rawDistribution.rss || null,
        discord: distro.rawDistribution.discord || null,
        servers: distro.servers.map(summarizeServer)
    }
}

/**
 * Structured config snapshot for the renderer mirror. Plain JSON only.
 *
 * @returns {Object} Config object plus environment values.
 */
exports.configSnapshot = function(){
    const javaConfig = ConfigManager.getJavaConfigs()
    return {
        config: {
            settings: {
                game: {
                    resWidth: ConfigManager.getGameWidth(),
                    resHeight: ConfigManager.getGameHeight(),
                    fullscreen: ConfigManager.getFullscreen(),
                    autoConnect: ConfigManager.getAutoConnect(),
                    launchDetached: ConfigManager.getLaunchDetached()
                },
                launcher: {
                    allowPrerelease: ConfigManager.getAllowPrerelease(),
                    dataDirectory: ConfigManager.getDataDirectory()
                }
            },
            newsCache: JSON.parse(JSON.stringify(ConfigManager.getNewsCache())),
            clientToken: ConfigManager.getClientToken(),
            selectedServer: ConfigManager.getSelectedServer(),
            selectedAccount: ConfigManager.getSelectedAccount() != null ? ConfigManager.getSelectedAccount().uuid : null,
            authenticationDatabase: JSON.parse(JSON.stringify(ConfigManager.getAuthAccounts())),
            modConfigurations: JSON.parse(JSON.stringify(ConfigManager.getModConfigurations())),
            javaConfig: JSON.parse(JSON.stringify(javaConfig))
        },
        firstLaunch: ConfigManager.isFirstLaunch(),
        defaults: {
            dataDirectory: ConfigManager.getDataDirectory(true),
            selectedServer: ConfigManager.getSelectedServer(true)
        },
        dirs: {
            launcher: ConfigManager.getLauncherDirectory(),
            data: ConfigManager.getDataDirectory(),
            common: ConfigManager.getCommonDirectory(),
            instance: ConfigManager.getInstanceDirectory()
        },
        mem: {
            total: os.totalmem(),
            free: os.freemem()
        }
    }
}

/**
 * The bootstrap payload served synchronously to the preload.
 *
 * @returns {Object} Environment, language map, config snapshot and
 * distribution type constants.
 */
exports.bootstrap = function(){
    const snapshot = exports.configSnapshot()
    return {
        isDev,
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        lang: LangLoader.getRaw(),
        config: snapshot.config,
        firstLaunch: snapshot.firstLaunch,
        defaults: snapshot.defaults,
        dirs: snapshot.dirs,
        mem: snapshot.mem,
        types: {
            Library: Type.Library,
            ForgeHosted: Type.ForgeHosted,
            Forge: Type.Forge,
            LiteLoader: Type.LiteLoader,
            LiteMod: Type.LiteMod,
            FabricMod: Type.FabricMod,
            File: Type.File,
            VersionManifest: Type.VersionManifest
        }
    }
}

exports.ConfigManager = ConfigManager
exports.DistroAPI = DistroAPI
exports.LangLoader = LangLoader
