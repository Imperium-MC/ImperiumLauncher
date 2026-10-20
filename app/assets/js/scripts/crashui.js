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
 * @param {Object} payload {summary, modLine, reportText, gameDir}
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
