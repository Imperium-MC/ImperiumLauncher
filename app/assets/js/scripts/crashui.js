/**
 * crashui.js — renderer half of the crash screen.
 *
 * The main process detects game crashes (crashscreen.js), builds the
 * summary and the clipboard report, and forwards a plain payload. This
 * script owns the overlay DOM: every value from the game log is attached
 * as text, and the clipboard / open-folder actions go through the
 * validated bridge.
 */
const loggerCrashUi = LoggerUtil.getLogger('CrashScreen')

Imperium.onCrashReport((payload) => {
    try {
        showCrashOverlay(payload)
    } catch(err){
        loggerCrashUi.error('Failed to display crash overlay.', err)
    }
})

/**
 * Populate and show the crash overlay.
 *
 * @param {Object} payload {summary, modLine, reportText, gameDir, upload}
 */
function showCrashOverlay(payload){
    document.getElementById('crashTitle').textContent = Lang.queryJS('landing.crash.title')
    document.getElementById('crashCause').textContent = payload.summary

    const modLine = document.getElementById('crashMod')
    if(payload.modLine != null){
        modLine.hidden = false
        modLine.textContent = payload.modLine
    } else {
        modLine.hidden = true
    }

    const copyButton = document.getElementById('crashCopyReport')
    copyButton.textContent = Lang.queryJS('landing.crash.copyReport')
    copyButton.onclick = () => {
        Imperium.clipboardWriteText(payload.reportText)
        copyButton.textContent = Lang.queryJS('landing.crash.copied')
        setTimeout(() => {
            copyButton.textContent = Lang.queryJS('landing.crash.copyReport')
        }, 2000)
    }

    setupSendReport(payload.upload)

    document.getElementById('crashOpenLogs').textContent = Lang.queryJS('landing.crash.openLogs')
    document.getElementById('crashOpenLogs').onclick = async () => {
        // The logs folder when it exists, the game directory otherwise;
        // both are resolved main-side.
        const res = await Imperium.openPath(payload.logsDir != null ? payload.logsDir : payload.gameDir)
        if(!res.ok){
            loggerCrashUi.error('Failed to open the game folder.', res.error)
        }
    }

    document.getElementById('crashClose').textContent = Lang.queryJS('landing.crash.close')
    document.getElementById('crashClose').onclick = () => {
        toggleOverlay(false)
    }

    if(typeof toggleLaunchArea === 'function'){
        toggleLaunchArea(false)
    }
    toggleOverlay(true, true, 'crashReportContent')
}

/**
 * Wire the Send Report action. The POST itself happens in the main
 * process (the renderer is sandboxed); this only passes the parsed
 * fields through the bridge and renders the result. The overlay's Close
 * button stays independent of this flow, so a slow or failed upload can
 * never trap the player.
 *
 * @param {Object} upload The already-parsed endpoint fields
 * {cause, mod, mcVersion, clientVersion, logTail, crashReport}.
 */
function setupSendReport(upload){
    const sendButton = document.getElementById('crashSendReport')
    const sendStatus = document.getElementById('crashSendStatus')
    const copyLinkButton = document.getElementById('crashCopyLink')
    const sendLabel = Lang.queryJS('landing.crash.sendReport')

    sendStatus.hidden = true
    sendStatus.textContent = ''
    copyLinkButton.hidden = true
    copyLinkButton.textContent = Lang.queryJS('landing.crash.copyLink')
    copyLinkButton.onclick = () => {
        Imperium.clipboardWriteText(sendStatus.textContent)
        copyLinkButton.textContent = Lang.queryJS('landing.crash.linkCopied')
        setTimeout(() => {
            copyLinkButton.textContent = Lang.queryJS('landing.crash.copyLink')
        }, 2000)
    }

    sendButton.hidden = false
    sendButton.disabled = false
    sendButton.textContent = sendLabel
    sendButton.onclick = () => {
        sendButton.disabled = true
        sendButton.textContent = Lang.queryJS('landing.crash.sending')
        sendStatus.hidden = true
        sendStatus.textContent = ''

        Imperium.crashReportUpload(upload).then((res) => {
            if(res != null && res.ok){
                // Plain text (the staff view path), selectable so it can
                // also be copied by hand.
                sendStatus.textContent = res.url
                sendStatus.hidden = false
                sendButton.hidden = true
                copyLinkButton.hidden = false
            } else {
                loggerCrashUi.warn('Crash report upload failed.', res != null ? res.error : res)
                sendStatus.textContent = Lang.queryJS('landing.crash.sendFailed')
                sendStatus.hidden = false
                // Keep the button available for a retry.
                sendButton.disabled = false
                sendButton.textContent = sendLabel
            }
        }).catch((err) => {
            loggerCrashUi.error('Crash report upload threw.', err)
            sendStatus.textContent = Lang.queryJS('landing.crash.sendFailed')
            sendStatus.hidden = false
            sendButton.disabled = false
            sendButton.textContent = sendLabel
        })
    }
}
