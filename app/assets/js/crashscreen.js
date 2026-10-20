/**
 * crashscreen.js — crash report overlay for the launched game process.
 *
 * The launcher used to log "Exited with code" and move on, leaving the
 * player with a silently closed game. This module watches the game
 * process ProcessBuilder spawned and surfaces a crash overlay when:
 *
 *   - the process exits non-zero within the first EARLY_CRASH_WINDOW_MS
 *     (a launch that dies that fast is a crash, not a quit), OR
 *   - a new file appears under the instance's crash-reports/ directory
 *     during the session (the game wrote a crash report).
 *
 * The overlay shows the deepest "Caused by:" line from the game log tail
 * and, when Fabric names one, the mod that provided the failing
 * entrypoint. Buttons copy the full report (log tail + crash report) to
 * the clipboard, open the logs folder, and close the overlay.
 *
 * DOM content is populated with textContent only; nothing from the game
 * log is ever interpreted as HTML.
 */
const fs     = require('fs-extra')
const path   = require('path')
const { LoggerUtil } = require('helios-core')
const Lang   = require('./langloader')

const logger = LoggerUtil.getLogger('CrashScreen')

/** Non-zero exits within this window of the spawn count as crashes. */
const EARLY_CRASH_WINDOW_MS = 2 * 60 * 1000
/** How often crash-reports/ is polled for new files. */
const CRASH_REPORT_POLL_MS = 5000
/** Game log lines kept for the cause parse and the clipboard report. */
const TAIL_LINES = 300
/** Maximum bytes of a crash report file appended to the clipboard. */
const CRASH_FILE_CLIPBOARD_LIMIT = 16 * 1024

const CAUSED_BY_REGEX = /^\s*Caused by:\s*(.+)$/
const PROVIDED_BY_REGEX = /provided by '([^']+)'/
const CRASH_REPORT_REGEX = /^crash-(\d{4}-\d{2}-\d{2}_\d{2}\.\d{2}\.\d{2})/

const CrashScreen = {

    /**
     * Watch a spawned game process and show the crash overlay when it
     * crashes. Attached from ProcessBuilder.build().
     *
     * @param {ChildProcess} child The spawned game process.
     * @param {string} gameDir The instance's game directory.
     */
    attach(child, gameDir){
        if(child == null || gameDir == null) {
            return
        }

        const state = {
            startedAt: Date.now(),
            shown: false,
            logLines: [],
            knownCrashFiles: new Set(),
            pollTimer: null
        }

        const pushLines = (data) => {
            for(const line of `${data}`.split(/\r?\n/)){
                const trimmed = line.trim()
                if(trimmed.length === 0) {
                    continue
                }
                state.logLines.push(trimmed)
                if(state.logLines.length > TAIL_LINES) {
                    state.logLines.shift()
                }
            }
        }
        child.stdout?.on('data', pushLines)
        child.stderr?.on('data', pushLines)

        const crashDir = path.join(gameDir, 'crash-reports')
        state.knownCrashFiles = new Set(CrashScreen._listCrashReports(crashDir, state.startedAt - 5000))

        // Poll for a crash report appearing mid-session: the game can write
        // one and exit 0 (or hang), which the exit-code rule would miss.
        state.pollTimer = setInterval(() => {
            const fresh = CrashScreen._listCrashReports(crashDir, state.startedAt)
                .filter(fileName => !state.knownCrashFiles.has(fileName))
            if(fresh.length === 0) {
                return
            }
            for(const fileName of fresh) {
                state.knownCrashFiles.add(fileName)
            }
            if(!state.shown) {
                CrashScreen._show(state, crashDir, null)
            }
        }, CRASH_REPORT_POLL_MS)

        child.on('close', (code) => {
            clearInterval(state.pollTimer)
            if(state.shown || code == null || code === 0) {
                return
            }
            if(Date.now() - state.startedAt > EARLY_CRASH_WINDOW_MS) {
                return
            }
            CrashScreen._show(state, crashDir, code)
        })
    },

    /**
     * List crash report files in the folder, optionally only those last
     * modified after the given time. Returns [] when the folder does not
     * exist yet (it is created by the game on its first crash).
     *
     * @param {string} crashDir The crash-reports directory.
     * @param {number} [modifiedSince] Epoch ms cutoff for mtime.
     * @returns {Array.<string>} Crash report file names.
     */
    _listCrashReports(crashDir, modifiedSince = 0){
        try {
            return fs.readdirSync(crashDir)
                .filter(fileName => CRASH_REPORT_REGEX.test(fileName))
                .filter(fileName => {
                    try {
                        return fs.statSync(path.join(crashDir, fileName)).mtimeMs >= modifiedSince
                    } catch {
                        return false
                    }
                })
                .sort()
        } catch {
            return []
        }
    },

    /**
     * Parse the crash summary from a game log tail.
     *
     * @param {Array.<string>} lines Game log lines (trimmed).
     * @returns {{cause: string|null, mod: string|null}} The deepest
     * "Caused by:" line and the mod Fabric's "provided by" line names.
     */
    _parseCrashSummary(lines){
        // The deepest cause is the LAST "Caused by:" line in the log.
        let cause = null
        for(const line of lines) {
            const match = line.match(CAUSED_BY_REGEX)
            if(match != null) {
                cause = match[1].trim()
            }
        }
        // Fabric entrypoint failures name the providing mod.
        let mod = null
        for(const line of lines) {
            const match = line.match(PROVIDED_BY_REGEX)
            if(match != null) {
                mod = match[1]
            }
        }
        return { cause, mod }
    },

    /**
     * Show the crash overlay.
     *
     * @param {Object} state The watcher state (log tail, timestamps).
     * @param {string} crashDir The crash-reports directory.
     * @param {number|null} exitCode The game's exit code, when it exited.
     */
    _show(state, crashDir, exitCode){
        state.shown = true
        clearInterval(state.pollTimer)

        const tail = state.logLines.slice()
        const { cause, mod } = CrashScreen._parseCrashSummary(tail)

        const crashFiles = CrashScreen._listCrashReports(crashDir, state.startedAt)
        const crashReportPath = crashFiles.length > 0 ? path.join(crashDir, crashFiles[crashFiles.length - 1]) : null
        const crashReportTail = crashReportPath != null ? CrashScreen._readTail(crashReportPath, CRASH_FILE_CLIPBOARD_LIMIT) : null

        // ---- Overlay population (textContent only) ----
        document.getElementById('crashTitle').textContent = Lang.queryJS('landing.crash.title')

        const desc = document.getElementById('crashCause')
        if(cause != null) {
            desc.textContent = cause
        } else if(exitCode != null) {
            desc.textContent = Lang.queryJS('landing.crash.exited', { code: exitCode })
        } else {
            desc.textContent = Lang.queryJS('landing.crash.unknownCause')
        }

        const modLine = document.getElementById('crashMod')
        if(mod != null) {
            modLine.hidden = false
            modLine.textContent = Lang.queryJS('landing.crash.providedBy', { mod })
        } else {
            modLine.hidden = true
        }

        const copyButton = document.getElementById('crashCopyReport')
        copyButton.textContent = Lang.queryJS('landing.crash.copyReport')
        copyButton.onclick = () => {
            const report = [
                'ImperiumMC crash report',
                `Time: ${new Date().toISOString()}`,
                exitCode != null ? `Exit code: ${exitCode}` : 'Exit code: n/a (crash report detected)',
                cause != null ? `Cause: ${cause}` : 'Cause: not parsed from the log',
                mod != null ? `Mod: ${mod}` : 'Mod: not identified',
                crashReportPath != null ? `Crash report: ${crashReportPath}` : 'Crash report: none',
                '',
                crashReportTail != null ? '--- crash report (tail) ---\n' + crashReportTail + '\n' : '',
                '--- game log (last ' + tail.length + ' lines) ---',
                tail.join('\n')
            ].join('\n')
            // Required lazily: this module is also loaded in plain node by
            // the test suite, where @electron/remote is unavailable.
            const remote = require('@electron/remote')
            remote.clipboard.writeText(report)
            copyButton.textContent = Lang.queryJS('landing.crash.copied')
            setTimeout(() => {
                copyButton.textContent = Lang.queryJS('landing.crash.copyReport')
            }, 2000)
        }

        document.getElementById('crashOpenLogs').textContent = Lang.queryJS('landing.crash.openLogs')
        document.getElementById('crashOpenLogs').onclick = async () => {
            const remote = require('@electron/remote')
            const logsDir = path.join(CrashScreen._gameDirFromCrashDir(crashDir), 'logs')
            const target = await fs.pathExists(logsDir) ? logsDir : CrashScreen._gameDirFromCrashDir(crashDir)
            const error = await remote.shell.openPath(target)
            if(error) {
                logger.error(`Failed to open ${target}:`, error)
            }
        }

        document.getElementById('crashClose').textContent = Lang.queryJS('landing.crash.close')
        document.getElementById('crashClose').onclick = () => {
            toggleOverlay(false)
        }

        if(typeof toggleLaunchArea === 'function') {
            toggleLaunchArea(false)
        }
        toggleOverlay(true, true, 'crashReportContent')
        logger.info(`Crash screen shown (exitCode=${exitCode}, crashReport=${crashReportPath}).`)
    },

    /**
     * @param {string} crashDir .../crash-reports
     * @returns {string} The instance game directory.
     */
    _gameDirFromCrashDir(crashDir){
        return path.dirname(crashDir)
    },

    /**
     * Read the last `limit` bytes of a file as UTF-8.
     *
     * @param {string} filePath The file to read.
     * @param {number} limit Maximum bytes to read from the end.
     * @returns {string|null} The tail content, or null when unreadable.
     */
    _readTail(filePath, limit){
        try {
            const { size } = fs.statSync(filePath)
            const start = Math.max(0, size - limit)
            const handle = fs.openSync(filePath, 'r')
            try {
                const buffer = Buffer.alloc(size - start)
                fs.readSync(handle, buffer, 0, buffer.length, start)
                return buffer.toString('utf8')
            } finally {
                fs.closeSync(handle)
            }
        } catch(err) {
            logger.warn(`Could not read crash report ${filePath}:`, err)
            return null
        }
    }

}

module.exports = CrashScreen
