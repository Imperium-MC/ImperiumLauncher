/**
 * Script for landing.ejs
 *
 * The launch pipeline itself (asset validation/download, process build,
 * Discord RPC, crash watching) runs in the main process; this script
 * drives its UI from launch events and owns everything visible on the
 * landing view.
 */
// Shared globals (bridge.js): $, Imperium, ConfigManager, DistroAPI, Lang,
// LoggerUtil, RenderUtil, NewsSanitize.

// Launch Elements
const launch_content          = document.getElementById('launch_content')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const launch_file_progress    = document.getElementById('launch_file_progress')
const server_selection_button = document.getElementById('server_selection_button')
const user_text               = document.getElementById('user_text')

const loggerLanding = LoggerUtil.getLogger('Landing')

/* Launch Progress Wrapper Functions */

/**
 * Show/hide the loading area.
 *
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading){
    if(loading){
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
    }
}

/**
 * Set the details text of the loading area.
 *
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details){
    launch_details_text.textContent = details
}

/**
 * Set the value of the loading progress bar and display that value.
 *
 * @param {number} percent Percentage (0-100)
 */
function setLaunchPercentage(percent){
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', percent)
    launch_progress_label.textContent = percent + '%'
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 *
 * @param {number} percent Percentage (0-100)
 */
function setDownloadPercentage(percent){
    Imperium.setProgressBar(percent/100)
    setLaunchPercentage(percent)
}

/**
 * Enable or disable the launch button.
 *
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val){
    document.getElementById('launch_button').disabled = !val
}

/* Per-artifact download progress detail */

// The download pipeline emits per-file progress far faster than the UI
// needs to repaint (large files fire a event per chunk). Pending text is
// cached and flushed on a 250ms interval (~4 updates/second).
let fileProgressPending = null
let fileProgressTimer = null

/**
 * Queue a per-file progress line for display. Throttled to ~4/s.
 *
 * @param {string} text The line to display, null clears the queue only.
 */
function queueFileProgressDetail(text){
    fileProgressPending = text
    if(fileProgressTimer == null){
        fileProgressTimer = setInterval(() => {
            if(fileProgressPending != null){
                launch_file_progress.textContent = fileProgressPending
                fileProgressPending = null
            }
        }, 250)
    }
}

/**
 * Display a per-file line immediately, bypassing the throttle.
 * Used for rare, high-signal events such as retry states.
 *
 * @param {string} text The line to display.
 */
function showFileProgressDetailNow(text){
    fileProgressPending = null
    launch_file_progress.textContent = text
}

/**
 * Clear and hide the per-file progress line, stopping the flush timer.
 */
function clearFileProgressDetail(){
    if(fileProgressTimer != null){
        clearInterval(fileProgressTimer)
        fileProgressTimer = null
    }
    fileProgressPending = null
    launch_file_progress.textContent = ''
}

// Bind launch button
document.getElementById('launch_button').addEventListener('click', async e => {
    loggerLanding.info('Launching game..')
    try {
        const prep = await Imperium.launchPrepare()
        if(prep.status === 'ready'){
            setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
            toggleLaunchArea(true)
            setLaunchPercentage(0)
            await Imperium.launch()
        } else if(prep.status === 'scan'){
            await asyncSystemScan(prep.effectiveJavaOptions)
        } else {
            showLaunchFailure(prep.error.title, prep.error.desc)
        }
    } catch(err) {
        loggerLanding.error('Unhandled error in during launch process.', err)
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.launch.failureText'))
    }
})

// Bind settings button
document.getElementById('settingsMediaButton').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings)
}

// Bind avatar overlay button.
document.getElementById('avatarOverlay').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        settingsNavItemListener(document.getElementById('settingsNavAccount'), false)
    })
}

// Bind selected account
function updateSelectedAccount(authUser){
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
        if(authUser.uuid != null){
            document.getElementById('avatarContainer').style.backgroundImage = `url('https://mc-heads.net/body/${authUser.uuid}/right')`
        }
    }
    user_text.textContent = username
}
updateSelectedAccount(ConfigManager.getSelectedAccount())

// Bind selected server
function updateSelectedServer(serv){
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    ConfigManager.save()
    server_selection_button.textContent = serv != null ? serv.rawServer.name : Lang.queryJS('landing.noSelection')
    if(getCurrentView() === VIEWS.settings){
        animateSettingsTabRefresh()
    }
    setLaunchEnabled(serv != null)
}
// Real text is set in uibinder.js on distributionIndexDone.
server_selection_button.textContent = Lang.queryJS('landing.selectedServer.loading')
server_selection_button.onclick = async e => {
    e.target.blur()
    await toggleServerSelection(true)
}

// Update Mojang Status Color

/**
 * Resolve a Mojang service status to its display color. Unknown or
 * malformed values resolve to grey rather than being trusted.
 *
 * @param {string} status The raw status value.
 * @returns {string} A hex color.
 */
function mojangStatusColor(status){
    switch(typeof status === 'string' ? status.toLowerCase() : ''){
        case 'green':
            return '#a5c325'
        case 'yellow':
            return '#eac918'
        case 'red':
            return '#c32625'
        default:
            return '#848484'
    }
}

/**
 * Build one row of the Mojang status tooltip. The service name comes
 * from the status API, so it is attached as text only.
 *
 * @param {Object} service A Mojang status entry.
 * @returns {HTMLElement} The tooltip row.
 */
function buildMojangStatusRow(service){
    const icon = RenderUtil.el('span', { class: 'mojangStatusIcon' })
    icon.style.color = mojangStatusColor(service.status)
    const rect = RenderUtil.svgEl('rect', { x: '0.5', y: '0.5', width: '7', height: '7', fill: 'currentColor' })
    const svg = RenderUtil.svgEl('svg', { width: '8', height: '8', viewBox: '0 0 8 8' })
    svg.appendChild(rect)
    icon.appendChild(svg)

    return RenderUtil.el('div', { class: 'mojangStatusContainer' }, [
        icon,
        RenderUtil.el('span', { class: 'mojangStatusName' }, service.name)
    ])
}

const refreshMojangStatuses = async function(){
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    const tooltipEssential = document.createDocumentFragment()
    const tooltipNonEssential = document.createDocumentFragment()

    const response = await Imperium.mojangStatus()
    const statuses = response.statuses

    greenCount = 0
    greyCount = 0

    for(let i=0; i<statuses.length; i++){
        const service = statuses[i]

        if(service.essential){
            tooltipEssential.appendChild(buildMojangStatusRow(service))
        } else {
            tooltipNonEssential.appendChild(buildMojangStatusRow(service))
        }

        if(service.status === 'yellow' && status !== 'red'){
            status = 'yellow'
        } else if(service.status === 'red'){
            status = 'red'
        } else {
            if(service.status === 'grey'){
                ++greyCount
            }
            ++greenCount
        }

    }

    if(greenCount === statuses.length){
        if(greyCount === statuses.length){
            status = 'grey'
        } else {
            status = 'green'
        }
    }

    document.getElementById('mojangStatusEssentialContainer').replaceChildren(tooltipEssential)
    document.getElementById('mojangStatusNonEssentialContainer').replaceChildren(tooltipNonEssential)
    document.getElementById('mojang_status_icon').style.color = mojangStatusColor(status)
}

/**
 * Coerce a server status player count to a displayable value. The
 * status ping is unauthenticated, so the value is only ever rendered
 * as text and non-numeric data degrades to a placeholder.
 *
 * @param {*} value The raw player count.
 * @returns {string} The displayable count.
 */
function formatPlayerCount(value){
    return Number.isFinite(value) ? String(value) : '?'
}

const refreshServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Server Status')

    let pLabel = Lang.queryJS('landing.serverStatus.server')
    let pVal = Lang.queryJS('landing.serverStatus.offline')

    try {

        const res = await Imperium.serverStatus()
        const servStat = res.status
        if(servStat != null && servStat.players != null){
            pLabel = Lang.queryJS('landing.serverStatus.players')
            pVal = formatPlayerCount(servStat.players.online) + '/' + formatPlayerCount(servStat.players.max)
        }

    } catch (err) {
        loggerLanding.warn('Unable to refresh server status, assuming offline.')
        loggerLanding.debug(err)
    }
    if(fade){
        $('#server_status_wrapper').fadeOut(250, () => {
            document.getElementById('landingPlayerLabel').textContent = pLabel
            document.getElementById('player_count').textContent = pVal
            $('#server_status_wrapper').fadeIn(500)
        })
    } else {
        document.getElementById('landingPlayerLabel').textContent = pLabel
        document.getElementById('player_count').textContent = pVal
    }

}

refreshMojangStatuses()
// Server Status is refreshed in uibinder.js on distributionIndexDone.

// Refresh statuses every hour. The status page itself refreshes every day so...
let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 60*60*1000)
// Set refresh rate to once every 5 minutes.
let serverStatusListener = setInterval(() => refreshServerStatus(true), 300000)

/**
 * Shows an error overlay, toggles off the launch area.
 *
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc){
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}

/**
 * Shows the download failure overlay with a Retry All action.
 * Retrying re-runs the full sync: files that already downloaded pass
 * validation, so only the artifacts that failed are fetched again.
 *
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showDownloadFailure(title, desc){
    setOverlayContent(
        title != null ? title : Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'),
        desc,
        Lang.queryJS('landing.dlAsync.retryAll'),
        Lang.queryJS('landing.dlAsync.cancelSync')
    )
    setOverlayHandler(() => {
        toggleOverlay(false)
        Imperium.launch()
    })
    setDismissHandler(() => {
        toggleOverlay(false)
        toggleLaunchArea(false)
    })
    toggleOverlay(true, true)
    toggleLaunchArea(false)
}

/* System (Java) Scan */

/**
 * Scan the system for a valid Java installation. The scan itself runs in
 * the main process; when nothing is found the user is offered to
 * download a JDK or pick manually.
 *
 * @param {Object} effectiveJavaOptions The selected server's effective java options.
 * @param {boolean} launchAfter Whether we should begin to launch after scanning.
 */
async function asyncSystemScan(effectiveJavaOptions, launchAfter = true){

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'))
    toggleLaunchArea(true)
    setLaunchPercentage(0)

    const scan = await Imperium.javaScan(effectiveJavaOptions)

    if(!scan.found) {
        // If no valid Java installation was found, show this information
        // to the user.
        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(() => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            toggleOverlay(false)

            try {
                downloadJava(effectiveJavaOptions, launchAfter)
            } catch(err) {
                loggerLanding.error('Unhandled error in Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'))
            }
        })
        setDismissHandler(() => {
            $('#overlayContent').fadeOut(250, () => {
                //$('#overlayDismiss').toggle(false)
                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)

                    asyncSystemScan(effectiveJavaOptions, launchAfter)
                })
                $('#overlayContent').fadeIn(250)
            })
        })
        toggleOverlay(true, true)
    } else {
        // Java installation found, use this to launch the game.
        const javaExec = scan.javaExec

        // We need to make sure that the updated value is on the settings UI.
        // Just incase the settings UI is already open.
        settingsJavaExecVal.value = javaExec
        await populateJavaExecDetails(settingsJavaExecVal.value)

        if(launchAfter){
            Imperium.launch()
        }
    }

}

/**
 * Download and extract a JDK through the main process, then re-run the
 * scan (which will now find the fresh installation).
 *
 * @param {Object} effectiveJavaOptions The selected server's effective java options.
 * @param {boolean} launchAfter Whether we should begin to launch after the download.
 */
async function downloadJava(effectiveJavaOptions, launchAfter = true) {

    const res = await Imperium.javaDownload(effectiveJavaOptions)

    if(!res.ok) {
        showLaunchFailure(res.title, res.desc)
        return
    }

    // The installed executable is picked up by the scan; the settings UI
    // value is updated through it.
    asyncSystemScan(effectiveJavaOptions, launchAfter)

}

/* Launch pipeline events */

/**
 * Translate launch pipeline events from the main process into the
 * progress UI. Everything display-facing lands here; the pipeline has
 * no other way to reach the DOM.
 *
 * @param {Object} payload The launch event payload.
 */
function handleLaunchEvent(payload){
    if(payload == null){
        return
    }
    switch(payload.kind){
        case 'details':
            setLaunchDetails(payload.text)
            break
        case 'progress':
            setLaunchPercentage(payload.percent)
            break
        case 'downloadProgress':
            setDownloadPercentage(payload.percent)
            break
        case 'fileProgress':
            queueFileProgressDetail(payload.text)
            break
        case 'fileRetry':
            showFileProgressDetailNow(payload.text)
            break
        case 'clearFileProgress':
            clearFileProgressDetail()
            break
        case 'loading':
            toggleLaunchArea(payload.value)
            break
        case 'failure':
            showLaunchFailure(payload.title, payload.desc)
            break
        case 'downloadFailure':
            showDownloadFailure(payload.title, payload.desc)
            break
        case 'gameLaunched':
            toggleLaunchArea(false)
            break
        case 'distroRefreshed':
            onDistroRefresh(payload.summary)
            break
        case 'javaIndeterminate':
            Imperium.setProgressBar(2)
            break
        case 'javaClear':
            Imperium.setProgressBar(-1)
            break
        default:
            break
    }
}

Imperium.onLaunchEvent(handleLaunchEvent)

/**
 * News Loading Functions
 */

// DOM Cache
const newsContent                   = document.getElementById('newsContent')
const newsArticleTitle              = document.getElementById('newsArticleTitle')
const newsArticleDate               = document.getElementById('newsArticleDate')
const newsArticleAuthor             = document.getElementById('newsArticleAuthor')
const newsArticleComments           = document.getElementById('newsArticleComments')
const newsNavigationStatus          = document.getElementById('newsNavigationStatus')
const newsArticleContentScrollable  = document.getElementById('newsArticleContentScrollable')
const nELoadSpan                    = document.getElementById('nELoadSpan')

// News slide caches.
let newsActive = false
let newsGlideCount = 0

/**
 * Show the news UI via a slide animation.
 *
 * @param {boolean} up True to slide up, otherwise false.
 */
function slide_(up){
    const lCUpper = document.querySelector('#landingContainer > #upper')
    const lCLLeft = document.querySelector('#landingContainer > #lower > #left')
    const lCLCenter = document.querySelector('#landingContainer > #lower > #center')
    const lCLRight = document.querySelector('#landingContainer > #lower > #right')
    const newsBtn = document.querySelector('#landingContainer > #lower > #center #content')
    const landingContainer = document.getElementById('landingContainer')
    const newsContainer = document.querySelector('#landingContainer > #newsContainer')

    newsGlideCount++

    if(up){
        lCUpper.style.top = '-200vh'
        lCLLeft.style.top = '-200vh'
        lCLCenter.style.top = '-200vh'
        lCLRight.style.top = '-200vh'
        newsBtn.style.top = '130vh'
        newsContainer.style.top = '0px'
        //date.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})
        //landingContainer.style.background = 'rgba(29, 29, 29, 0.55)'
        landingContainer.style.background = 'rgba(0, 0, 0, 0.50)'
        setTimeout(() => {
            if(newsGlideCount === 1){
                lCLCenter.style.transition = 'none'
                newsBtn.style.transition = 'none'
            }
            newsGlideCount--
        }, 2000)
    } else {
        setTimeout(() => {
            newsGlideCount--
        }, 2000)
        landingContainer.style.background = null
        lCLCenter.style.transition = null
        newsBtn.style.transition = null
        newsContainer.style.top = '100%'
        lCUpper.style.top = '0px'
        lCLLeft.style.top = '0px'
        lCLCenter.style.top = '0px'
        lCLRight.style.top = '0px'
        newsBtn.style.top = '10px'
    }
}

// Bind news button.
document.getElementById('newsButton').onclick = () => {
    // Toggle tabbing.
    if(newsActive){
        $('#landingContainer *').removeAttr('tabindex')
        $('#newsContainer *').attr('tabindex', '-1')
    } else {
        $('#landingContainer *').attr('tabindex', '-1')
        $('#newsContainer, #newsContainer *, #lower, #lower #center *').removeAttr('tabindex')
        if(newsAlertShown){
            $('#newsButtonAlert').fadeOut(2000)
            newsAlertShown = false
            ConfigManager.setNewsCacheDismissed(true)
            ConfigManager.save()
        }
    }
    slide_(!newsActive)
    newsActive = !newsActive
}

// Array to store article meta.
let newsArr = null

// News load animation listener.
let newsLoadingListener = null

/**
 * Set the news loading animation.
 *
 * @param {boolean} val True to set loading animation, false to remove.
 */
function setNewsLoading(val){
    if(val){
        const nLStr = Lang.queryJS('landing.news.checking')
        let dotStr = '..'
        nELoadSpan.textContent = nLStr + dotStr
        newsLoadingListener = setInterval(() => {
            if(dotStr.length >= 3){
                dotStr = ''
            } else {
                dotStr += '.'
            }
            nELoadSpan.textContent = nLStr + dotStr
        }, 750)
    } else {
        if(newsLoadingListener != null){
            clearInterval(newsLoadingListener)
            newsLoadingListener = null
        }
    }
}

// Bind retry button.
newsErrorRetry.onclick = () => {
    $('#newsErrorFailed').fadeOut(250, () => {
        initNews()
        $('#newsErrorLoading').fadeIn(250)
    })
}

newsArticleContentScrollable.onscroll = (e) => {
    if(e.target.scrollTop > Number.parseFloat($('.newsArticleSpacerTop').css('height'))){
        newsContent.setAttribute('scrolled', '')
    } else {
        newsContent.removeAttribute('scrolled')
    }
}

/**
 * Reload the news without restarting.
 *
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
function reloadNews(){
    return new Promise((resolve, reject) => {
        $('#newsContent').fadeOut(250, () => {
            $('#newsErrorLoading').fadeIn(250)
            initNews().then(() => {
                resolve()
            })
        })
    })
}

let newsAlertShown = false

/**
 * Show the news alert indicating there is new news.
 */
function showNewsAlert(){
    newsAlertShown = true
    $(newsButtonAlert).fadeIn(250)
}

/**
 * Hash a string for the "is this news new" comparison. Prefers
 * SubtleCrypto; falls back to a deterministic string hash when the web
 * crypto subtle API is unavailable.
 *
 * @param {string} str The string to digest.
 * @returns {Promise.<string>} The hex-ish digest.
 */
async function digestMessage(str) {
    if(crypto?.subtle?.digest != null){
        const msgUint8 = new TextEncoder().encode(str)
        const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8)
        const hashArray = Array.from(new Uint8Array(hashBuffer))
        return hashArray
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
    }
    let h1 = 0xdeadbeef
    let h2 = 0x41c6ce57
    for(let i = 0; i < str.length; i++){
        const ch = str.charCodeAt(i)
        h1 = Math.imul(h1 ^ ch, 2654435761)
        h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16)
}

/**
 * Initialize News UI. This will load the news and prepare
 * the UI accordingly.
 *
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
async function initNews(){

    setNewsLoading(true)

    const news = await loadNews()

    newsArr = news?.articles || null

    if(newsArr == null){
        // News Loading Failed
        setNewsLoading(false)

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorFailed').fadeIn(250).promise()

    } else if(newsArr.length === 0) {
        // No News Articles
        setNewsLoading(false)

        ConfigManager.setNewsCache({
            date: null,
            content: null,
            dismissed: false
        })
        ConfigManager.save()

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorNone').fadeIn(250).promise()
    } else {
        // Success
        setNewsLoading(false)

        const lN = newsArr[0]
        const cached = ConfigManager.getNewsCache()
        let newHash = await digestMessage(lN.content)
        let newDate = new Date(lN.date)
        let isNew = false

        if(cached.date != null && cached.content != null){

            if(new Date(cached.date) >= newDate){

                // Compare Content
                if(cached.content !== newHash){
                    isNew = true
                    showNewsAlert()
                } else {
                    if(!cached.dismissed){
                        isNew = true
                        showNewsAlert()
                    }
                }

            } else {
                isNew = true
                showNewsAlert()
            }

        } else {
            isNew = true
            showNewsAlert()
        }

        if(isNew){
            ConfigManager.setNewsCache({
                date: newDate.getTime(),
                content: newHash,
                dismissed: false
            })
            ConfigManager.save()
        }

        const switchHandler = (forward) => {
            let cArt = parseInt(newsContent.getAttribute('article'))
            let nxtArt = forward ? (cArt >= newsArr.length-1 ? 0 : cArt + 1) : (cArt <= 0 ? newsArr.length-1 : cArt - 1)

            displayArticle(newsArr[nxtArt], nxtArt+1)
        }

        document.getElementById('newsNavigateRight').onclick = () => { switchHandler(true) }
        document.getElementById('newsNavigateLeft').onclick = () => { switchHandler(false) }
        await $('#newsErrorContainer').fadeOut(250).promise()
        displayArticle(newsArr[0], 1)
        await $('#newsContent').fadeIn(250).promise()
    }


}

/**
 * Add keyboard controls to the news UI. Left and right arrows toggle
 * between articles. If you are on the landing page, the up arrow will
 * open the news UI.
 */
document.addEventListener('keydown', (e) => {
    if(newsActive){
        if(e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
            document.getElementById(e.key === 'ArrowRight' ? 'newsNavigateRight' : 'newsNavigateLeft').click()
        }
        // Interferes with scrolling an article using the down arrow.
        // Not sure of a straight forward solution at this point.
        // if(e.key === 'ArrowDown'){
        //     document.getElementById('newsButton').click()
        // }
    } else {
        if(getCurrentView() === VIEWS.landing){
            if(e.key === 'ArrowUp'){
                document.getElementById('newsButton').click()
            }
        }
    }
})

/**
 * Set an anchor's href only when the target passes the external link
 * policy. Anything else leaves the element without a navigable target.
 *
 * @param {HTMLAnchorElement} anchor The anchor element.
 * @param {string} url The candidate URL.
 */
function setArticleLink(anchor, url){
    if(NewsSanitize.isAllowedLink(url)){
        anchor.href = url
    } else {
        anchor.removeAttribute('href')
    }
}

/**
 * Display a news article on the UI.
 *
 * @param {Object} articleObject The article meta object.
 * @param {number} index The article index.
 */
function displayArticle(articleObject, index){
    newsArticleTitle.textContent = articleObject.title
    setArticleLink(newsArticleTitle, articleObject.link)
    newsArticleAuthor.textContent = 'by ' + articleObject.author
    newsArticleDate.textContent = articleObject.date
    newsArticleComments.textContent = articleObject.comments
    setArticleLink(newsArticleComments, articleObject.commentsLink)

    const wrapper = RenderUtil.el('div', { id: 'newsArticleContentWrapper' })
    const body = RenderUtil.el('div')
    NewsSanitize.setSanitizedHtml(body, articleObject.content)
    wrapper.appendChild(RenderUtil.el('div', { class: 'newsArticleSpacerTop' }))
    wrapper.appendChild(body)
    wrapper.appendChild(RenderUtil.el('div', { class: 'newsArticleSpacerBot' }))
    newsArticleContentScrollable.replaceChildren(wrapper)

    Array.from(newsArticleContentScrollable.getElementsByClassName('bbCodeSpoilerButton')).forEach(v => {
        v.onclick = () => {
            const text = v.parentElement.getElementsByClassName('bbCodeSpoilerText')[0]
            text.style.display = text.style.display === 'block' ? 'none' : 'block'
        }
    })
    newsNavigationStatus.textContent = Lang.query('ejs.landing.newsNavigationStatus', {currentPage: index, totalPages: newsArr.length})
    newsContent.setAttribute('article', index-1)
}

/**
 * Load news information from the RSS feed specified in the
 * distribution index. Falls back to the ImperiumMC news feed when the
 * distribution does not declare one. If the feed is unreachable, the
 * panel resolves with an empty list so it stays gracefully empty.
 */
async function loadNews(){

    const distroData = await DistroAPI.getDistribution()

    // ROMANICA CUTOVER: fallback feed flips to romanica.net when DNS is live
    // (mirrors the distribution index's rss key).
    const newsFeed = distroData.rawDistribution.rss || 'https://romanica.net/news.rss'
    if(!distroData.rawDistribution.rss) {
        loggerLanding.debug('No RSS feed declared in distribution index, using default feed.')
    }

    const promise = new Promise((resolve, reject) => {

        let newsHost
        try {
            newsHost = new URL(newsFeed).origin + '/'
        } catch(err) {
            loggerLanding.warn('Invalid RSS feed URL declared.', err)
            resolve({ articles: [] })
            return
        }
        $.ajax({
            url: newsFeed,
            success: (data) => {
                const items = $(data).find('item')
                const articles = []

                for(let i=0; i<items.length; i++){
                // JQuery Element
                    const el = $(items[i])

                    // Resolve date.
                    const date = new Date(el.find('pubDate').text()).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})

                    // Resolve comments.
                    let comments = el.find('slash\\:comments').text() || '0'
                    comments = comments + ' Comment' + (comments === '1' ? '' : 's')

                    // Full content when available, plain description otherwise.
                    let content = el.find('content\\:encoded').text() || el.find('description').text()
                    // Fix relative links in content.
                    let regex = /src="(?!http:\/\/|https:\/\/)(.+?)"/g
                    let matches
                    while((matches = regex.exec(content))){
                        content = content.replace(`"${matches[1]}"`, `"${newsHost + matches[1]}"`)
                    }

                    let link   = el.find('link').text()
                    let title  = el.find('title').text()
                    let author = el.find('dc\\:creator').text() || 'Romanica'

                    // Generate article.
                    articles.push(
                        {
                            link,
                            title,
                            date,
                            author,
                            content,
                            comments,
                            commentsLink: link + '#comments'
                        }
                    )
                }
                resolve({
                    articles
                })
            },
            timeout: 5000
        }).catch(err => {
            // Feed unreachable: keep the news panel gracefully empty.
            loggerLanding.warn('Unable to load news feed.', err)
            resolve({
                articles: []
            })
        })
    })

    return await promise
}
