/**
 * bridge.js — renderer-side half of the imperative bridge.
 *
 * Loaded before every other launcher script, it rebuilds the shared
 * globals the node-integrated scripts used to require(): LoggerUtil,
 * Lang, ConfigManager (a mirror over IPC), DistroAPI, AuthManager and
 * the small constants. The page itself has no node access; all state
 * changes travel through window.imperium and are validated in the main
 * process.
 */
const Imperium = window.imperium
const isDev = Imperium.env.isDev

/* ------------------------------------------------------------------ */
/* Logging                                                            */
/* ------------------------------------------------------------------ */

const LoggerUtil = {
    getLogger(name){
        const forward = (level, args) => {
            try {
                Imperium.log(name, level, args)
            } catch(_err){
                // Logging must never break the caller.
            }
        }
        return {
            info(...args){
                console.log(`[${name}]`, ...args)
                forward('info', args)
            },
            warn(...args){
                console.warn(`[${name}]`, ...args)
                forward('warn', args)
            },
            error(...args){
                console.error(`[${name}]`, ...args)
                forward('error', args)
            },
            debug(...args){
                if(isDev){
                    console.log(`[${name}:debug]`, ...args)
                }
                forward('debug', args)
            }
        }
    }
}

const loggerBridge = LoggerUtil.getLogger('Bridge')

/* ------------------------------------------------------------------ */
/* Language                                                           */
/* ------------------------------------------------------------------ */

const Lang = (function(){
    const lang = Imperium.env.lang

    function query(id, placeHolders){
        let query = id.split('.')
        let res = lang
        for(let q of query){
            res = res[q]
        }
        let text = res === lang ? '' : res
        if(placeHolders){
            Object.entries(placeHolders).forEach(([key, value]) => {
                text = text.replace(`{${key}}`, value)
            })
        }
        return text
    }

    return {
        query,
        queryJS(id, placeHolders){
            return query(`js.${id}`, placeHolders)
        }
    }
})()

/* ------------------------------------------------------------------ */
/* ConfigManager mirror                                               */
/* ------------------------------------------------------------------ */

const ConfigManager = (function(){
    let config = Imperium.env.config
    let firstLaunch = Imperium.env.firstLaunch
    let defaults = Imperium.env.defaults
    let dirs = Imperium.env.dirs
    let totalMem = Imperium.env.mem.total

    /**
     * Replace the mirror from a main-process snapshot.
     */
    function refresh(snapshot){
        if(snapshot == null || snapshot.config == null){
            return
        }
        config = snapshot.config
        firstLaunch = snapshot.firstLaunch
        defaults = snapshot.defaults
        dirs = snapshot.dirs
    }

    /**
     * Forward a named mutation to the main process. The same change is
     * applied locally first so synchronous reads keep working; the main
     * process is the persistence authority and re-validates every op.
     */
    function apply(op, args){
        Imperium.configApply(op, args)
            .then(envelope => {
                if(!envelope.ok){
                    loggerBridge.error(`Configuration operation ${op} was rejected.`, envelope.error)
                }
            })
            .catch(err => loggerBridge.error(`Configuration operation ${op} failed.`, err))
    }

    const manager = {

        _refresh: refresh,

        getLauncherDirectory(){
            return dirs.launcher
        },

        getDataDirectory(def = false){
            return !def ? config.settings.launcher.dataDirectory : defaults.dataDirectory
        },

        setDataDirectory(dataDirectory){
            config.settings.launcher.dataDirectory = dataDirectory
            apply('setDataDirectory', [dataDirectory])
        },

        getAbsoluteMinRAM(ram){
            if(ram?.minimum != null){
                return ram.minimum/1024
            }
            return totalMem >= (6*1073741824) ? 3 : 2
        },

        getAbsoluteMaxRAM(_ram){
            const mem = totalMem
            const gT16 = mem-(16*1073741824)
            return Math.floor((mem-(gT16 > 0 ? (Number.parseInt(gT16/8) + (16*1073741824)/4) : mem/4))/1073741824)
        },

        save(){
            return Imperium.configSave()
                .then(envelope => {
                    refresh(envelope.snapshot)
                    return envelope
                })
                .catch(err => loggerBridge.error('Failed to save configuration.', err))
        },

        isLoaded(){
            return true
        },

        isFirstLaunch(){
            return firstLaunch
        },

        getNewsCache(){
            return config.newsCache
        },

        setNewsCache(newsCache){
            config.newsCache = newsCache
            apply('setNewsCache', [newsCache])
        },

        setNewsCacheDismissed(dismissed){
            config.newsCache.dismissed = dismissed
            apply('setNewsCacheDismissed', [dismissed])
        },

        getCommonDirectory(){
            return dirs.common
        },

        getInstanceDirectory(){
            return dirs.instance
        },

        getClientToken(){
            return config.clientToken
        },

        getSelectedServer(def = false){
            return !def ? config.selectedServer : defaults.selectedServer
        },

        setSelectedServer(serverID){
            config.selectedServer = serverID
            apply('setSelectedServer', [serverID])
        },

        getAuthAccounts(){
            return config.authenticationDatabase
        },

        getAuthAccount(uuid){
            return config.authenticationDatabase[uuid]
        },

        addMojangAuthAccount(uuid, accessToken, username, displayName){
            config.selectedAccount = uuid
            config.authenticationDatabase[uuid] = {
                type: 'mojang',
                accessToken,
                username: username.trim(),
                uuid: uuid.trim(),
                displayName: displayName.trim()
            }
            apply('addMojangAuthAccount', [uuid, accessToken, username, displayName])
            return config.authenticationDatabase[uuid]
        },

        addMicrosoftAuthAccount(uuid, accessToken, name, mcExpires, msAccessToken, msRefreshToken, msExpires){
            config.selectedAccount = uuid
            config.authenticationDatabase[uuid] = {
                type: 'microsoft',
                accessToken,
                username: name.trim(),
                uuid: uuid.trim(),
                displayName: name.trim(),
                expiresAt: mcExpires,
                microsoft: {
                    access_token: msAccessToken,
                    refresh_token: msRefreshToken,
                    expires_at: msExpires
                }
            }
            apply('addMicrosoftAuthAccount', [uuid, accessToken, name, mcExpires, msAccessToken, msRefreshToken, msExpires])
            return config.authenticationDatabase[uuid]
        },

        removeAuthAccount(uuid){
            if(config.authenticationDatabase[uuid] != null){
                delete config.authenticationDatabase[uuid]
                if(config.selectedAccount === uuid){
                    const keys = Object.keys(config.authenticationDatabase)
                    if(keys.length > 0){
                        config.selectedAccount = keys[0]
                    } else {
                        config.selectedAccount = null
                        config.clientToken = null
                    }
                }
                apply('removeAuthAccount', [uuid])
                return true
            }
            return false
        },

        getSelectedAccount(){
            return config.authenticationDatabase[config.selectedAccount]
        },

        setSelectedAccount(uuid){
            const authAcc = config.authenticationDatabase[uuid]
            if(authAcc != null){
                config.selectedAccount = uuid
                apply('setSelectedAccount', [uuid])
            }
            return authAcc
        },

        getModConfigurations(){
            return config.modConfigurations
        },

        setModConfigurations(configurations){
            config.modConfigurations = configurations
            apply('setModConfigurations', [configurations])
        },

        getModConfiguration(serverid){
            const cfgs = config.modConfigurations
            for(let i=0; i<cfgs.length; i++){
                if(cfgs[i].id === serverid){
                    return cfgs[i]
                }
            }
            return null
        },

        setModConfiguration(serverid, configuration){
            const cfgs = config.modConfigurations
            for(let i=0; i<cfgs.length; i++){
                if(cfgs[i].id === serverid){
                    cfgs[i] = configuration
                    apply('setModConfiguration', [serverid, configuration])
                    return
                }
            }
            cfgs.push(configuration)
            apply('setModConfiguration', [serverid, configuration])
        },

        getMinRAM(serverid){
            return config.javaConfig[serverid].minRAM
        },

        setMinRAM(serverid, minRAM){
            config.javaConfig[serverid].minRAM = minRAM
            apply('setMinRAM', [serverid, minRAM])
        },

        getMaxRAM(serverid){
            return config.javaConfig[serverid].maxRAM
        },

        setMaxRAM(serverid, maxRAM){
            config.javaConfig[serverid].maxRAM = maxRAM
            apply('setMaxRAM', [serverid, maxRAM])
        },

        getJavaExecutable(serverid){
            return config.javaConfig[serverid] != null ? config.javaConfig[serverid].executable : null
        },

        setJavaExecutable(serverid, executable){
            config.javaConfig[serverid].executable = executable
            apply('setJavaExecutable', [serverid, executable])
        },

        getJVMOptions(serverid){
            return config.javaConfig[serverid].jvmOptions
        },

        setJVMOptions(serverid, jvmOptions){
            config.javaConfig[serverid].jvmOptions = jvmOptions
            apply('setJVMOptions', [serverid, jvmOptions])
        },

        getGameWidth(def = false){
            return !def ? config.settings.game.resWidth : 1280
        },

        setGameWidth(resWidth){
            config.settings.game.resWidth = Number.parseInt(resWidth)
            apply('setGameWidth', [Number.parseInt(resWidth)])
        },

        validateGameWidth(resWidth){
            const nVal = Number.parseInt(resWidth)
            return Number.isInteger(nVal) && nVal >= 0
        },

        getGameHeight(def = false){
            return !def ? config.settings.game.resHeight : 720
        },

        setGameHeight(resHeight){
            config.settings.game.resHeight = Number.parseInt(resHeight)
            apply('setGameHeight', [Number.parseInt(resHeight)])
        },

        validateGameHeight(resHeight){
            const nVal = Number.parseInt(resHeight)
            return Number.isInteger(nVal) && nVal >= 0
        },

        getFullscreen(def = false){
            return !def ? config.settings.game.fullscreen : false
        },

        setFullscreen(fullscreen){
            config.settings.game.fullscreen = fullscreen
            apply('setFullscreen', [fullscreen])
        },

        getAutoConnect(def = false){
            return !def ? config.settings.game.autoConnect : true
        },

        setAutoConnect(autoConnect){
            config.settings.game.autoConnect = autoConnect
            apply('setAutoConnect', [autoConnect])
        },

        getLaunchDetached(def = false){
            return !def ? config.settings.game.launchDetached : true
        },

        setLaunchDetached(launchDetached){
            config.settings.game.launchDetached = launchDetached
            apply('setLaunchDetached', [launchDetached])
        },

        getAllowPrerelease(def = false){
            return !def ? config.settings.launcher.allowPrerelease : false
        },

        setAllowPrerelease(allowPrerelease){
            config.settings.launcher.allowPrerelease = allowPrerelease
            apply('setAllowPrerelease', [allowPrerelease])
        }
    }

    return manager
})()

/* ------------------------------------------------------------------ */
/* DistroAPI wrapper                                                  */
/* ------------------------------------------------------------------ */

const Type = Imperium.env.types

/**
 * Attach the module helper methods the UI code calls. The underlying
 * values arrive as plain JSON from the main-process summary.
 */
function hydrateDistroModule(m){
    m.rawModule = {
        id: m.id,
        name: m.name,
        type: m.type
    }
    m.getRequired = function(){
        return this.required
    }
    m.getVersionlessMavenIdentifier = function(){
        return this.versionlessId
    }
    m.hasSubModules = function(){
        return this.subModules.length > 0
    }
    m.mavenComponents = { version: m.version }
    m.subModules.forEach(hydrateDistroModule)
    return m
}

function wrapDistributionSummary(summary){
    for(const server of summary.servers){
        server.modules.forEach(hydrateDistroModule)
    }
    const wrapped = {
        rawDistribution: {
            rss: summary.rss,
            discord: summary.discord
        },
        servers: summary.servers
    }
    wrapped.getServerById = function(id){
        return this.servers.find(s => s.rawServer.id === id) || null
    }
    wrapped.getMainServer = function(){
        return this.servers.find(s => s.rawServer.mainServer) || this.servers[0] || null
    }
    return wrapped
}

const DistroAPI = {
    _distro: null,

    async getDistribution(){
        if(this._distro == null){
            const res = await Imperium.distroSummary()
            if(!res.ok || res.summary == null){
                throw new Error('Unable to load the distribution index.')
            }
            this._distro = wrapDistributionSummary(res.summary)
        }
        return this._distro
    },

    /**
     * Replace the cached distribution after a main-side refresh.
     */
    async _adoptSummary(summary){
        this._distro = wrapDistributionSummary(summary)
        return this._distro
    }
}

/* ------------------------------------------------------------------ */
/* AuthManager wrapper                                                */
/* ------------------------------------------------------------------ */

/**
 * Whether an error value carries a user-displayable title/desc pair
 * (helios-core's isDisplayableError contract).
 */
function isDisplayableError(err){
    return err != null && typeof err === 'object'
        && typeof err.title === 'string' && typeof err.desc === 'string'
}

const AuthManager = {

    async addMojangAccount(username, password){
        const envelope = await Imperium.authAddMojang(username, password)
        ConfigManager._refresh(envelope.snapshot)
        if(envelope.ok){
            return envelope.account
        }
        return Promise.reject(envelope.error)
    },

    async addMicrosoftAccount(authCode){
        const envelope = await Imperium.authAddMicrosoft(authCode)
        ConfigManager._refresh(envelope.snapshot)
        if(envelope.ok){
            return envelope.account
        }
        return Promise.reject(envelope.error)
    },

    async removeMojangAccount(uuid){
        const envelope = await Imperium.authRemoveMojang(uuid)
        ConfigManager._refresh(envelope.snapshot)
        if(!envelope.ok){
            return Promise.reject(envelope.error)
        }
    },

    async removeMicrosoftAccount(uuid){
        const envelope = await Imperium.authRemoveMicrosoft(uuid)
        ConfigManager._refresh(envelope.snapshot)
        if(!envelope.ok){
            return Promise.reject(envelope.error)
        }
    },

    /**
     * Validate (and refresh) the selected account. When the account
     * cannot be salvaged the main process removes it; the returned
     * account is the removed one so the UI can offer to re-add it.
     *
     * @returns {Promise.<{valid: boolean, account: Object|null}>}
     */
    async validateSelected(){
        const envelope = await Imperium.authValidateSelected()
        ConfigManager._refresh(envelope.snapshot)
        return { valid: envelope.valid, account: envelope.account }
    }
}

/* ------------------------------------------------------------------ */
/* Shared constants and small utilities                               */
/* ------------------------------------------------------------------ */

const MSFT_OPCODE = {
    OPEN_LOGIN: 'MSFT_AUTH_OPEN_LOGIN',
    OPEN_LOGOUT: 'MSFT_AUTH_OPEN_LOGOUT',
    REPLY_LOGIN: 'MSFT_AUTH_REPLY_LOGIN',
    REPLY_LOGOUT: 'MSFT_AUTH_REPLY_LOGOUT'
}
const MSFT_REPLY_TYPE = {
    SUCCESS: 'MSFT_AUTH_REPLY_SUCCESS',
    ERROR: 'MSFT_AUTH_REPLY_ERROR'
}
const MSFT_ERROR = {
    ALREADY_OPEN: 'MSFT_AUTH_ERR_ALREADY_OPEN',
    NOT_FINISHED: 'MSFT_AUTH_ERR_NOT_FINISHED',
    NOT_CONFIGURED: 'MSFT_AUTH_ERR_NOT_CONFIGURED'
}
const SHELL_OPCODE = {
    TRASH_ITEM: 'TRASH_ITEM',
    OPEN_EXTERNAL: 'SHELL_OPEN_EXTERNAL'
}

/**
 * Whether a version string is a prerelease (semver-lite: the local
 * replacement for semver.prerelease, used only for display decisions).
 */
function isPrereleaseVersion(version){
    if(typeof version !== 'string'){
        return false
    }
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))/.exec(version)
    return match != null && match[4] != null && match[4].length > 0
}

/**
 * Bare alias for RenderUtil.buildServerListingChildren, kept for the
 * settings mods tab which calls it unqualified.
 */
const buildServerListingChildren = RenderUtil.buildServerListingChildren
