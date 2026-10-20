/**
 * launch-smoke.cjs — CI driver for the Windows launch smoke test (issue #5).
 *
 * Runs under plain node on the GitHub Actions windows runner. The launcher
 * itself does the real work: this script pre-seeds an offline account into
 * the launcher's config.json (exact ConfigManager shape), copies Mesa's
 * software opengl32.dll next to the Temurin javaw.exe the game will use,
 * starts dist/win-unpacked/Imperium Launcher.exe with
 * IMPERIUM_SMOKE_LAUNCH=1 (headless: no launcher UI, the main process runs
 * the full distribution -> asset sync -> ProcessBuilder pipeline), and
 * watches the game's logs/latest.log.
 *
 * PASS: the log reaches a title-screen / resource-reload marker within the
 * game window with no UnsatisfiedLinkError, no Fabric entrypoint crash, no
 * mixin apply failure and no saved crash report. The launcher itself also
 * refuses to spawn when lwjgl.dll is missing from the resolved natives
 * folder (the #4 regression guard, see ProcessBuilder._verifySmokeNatives).
 *
 * Everything decision-shaped is a pure exported function so the driver is
 * unit-testable without spawning anything (test/smoke-driver.test.js).
 *
 * Usage:
 *   node test/smoke/launch-smoke.cjs \
 *     --exe "dist/win-unpacked/Imperium Launcher.exe" \
 *     --data-dir "$RUNNER_TEMP/imperium-data" \
 *     --java-home "$RUNNER_TEMP/jdk-25-jre" \
 *     --mesa "$RUNNER_TEMP/mesa/x64/opengl32.dll" \
 *     --server ImperiumMC \
 *     --artifacts-dir .smoke-artifacts
 */
const fs   = require('fs')
const os   = require('os')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..', '..')

/* ------------------------------ log markers ------------------------------ */

/**
 * Title-screen / resource-reload-finished markers. "Sound engine started"
 * is the same line the launcher itself trusts for game-started detection
 * and fires when the title screen becomes interactive after the initial
 * resource load; the atlas-creation line is the reload-finished trace.
 */
const PASS_PATTERNS = [
    /Sound engine started/,
    /Created: \d+x\d+x\d+ minecraft:textures\/atlas\/blocks\.png-atlas/
]

/**
 * Startup failure markers from the issue: native load failures, Fabric
 * mod startup crashes, mixin failures, and a crash report being written.
 */
const FAIL_PATTERNS = [
    /UnsatisfiedLinkError/,
    /Could not execute entrypoint stage/,
    /Mod initialization failed/i,
    /Mixin apply failed/,
    /Exception in thread "Render thread"/,
    /Crash report saved to/,
    /Failed to create window/
]

/**
 * Classify game log content.
 *
 * @param {string} text The log content seen so far.
 * @returns {{passed: boolean, failed: boolean, match: ?string}}
 */
function scanLog(text){
    for(const pattern of FAIL_PATTERNS){
        if(pattern.test(text)){
            return { passed: false, failed: true, match: `fail: ${pattern}` }
        }
    }
    for(const pattern of PASS_PATTERNS){
        if(pattern.test(text)){
            return { passed: true, failed: false, match: `pass: ${pattern}` }
        }
    }
    return { passed: false, failed: false, match: null }
}

/* --------------------------- pre-seeded config --------------------------- */

/**
 * The config.json the smoke run starts from. Matches ConfigManager's
 * DEFAULT_CONFIG shape exactly (every top-level key present) so its
 * loader neither rewrites nor discards anything: the offline account is
 * the exact addMojangAuthAccount serialization, and the javaConfig entry
 * mirrors defaultJavaConfig17 with our executable and RAM.
 *
 * @param {Object} options {serverId, uuid, name, dataDir, javaExec}
 * @returns {Object} The config object to write.
 */
function buildSmokeConfig({ serverId, uuid, name, dataDir, javaExec, ramMB = 4096 }){
    const ram = `${ramMB}M`
    return {
        settings: {
            game: {
                resWidth: 1280,
                resHeight: 720,
                fullscreen: false,
                // Stop at the title screen: never quick-connect to the
                // real server (also what keeps --quickPlay* out of the
                // game arguments).
                autoConnect: false,
                // Keep javaw a child of the launcher process so the
                // driver can clean up the whole tree with one kill.
                launchDetached: false
            },
            launcher: {
                allowPrerelease: false,
                dataDirectory: dataDir
            }
        },
        newsCache: {
            date: null,
            content: null,
            dismissed: true
        },
        clientToken: null,
        selectedServer: serverId,
        selectedAccount: uuid,
        authenticationDatabase: {
            [uuid]: {
                type: 'mojang',
                accessToken: '0',
                username: name,
                uuid: uuid,
                displayName: name
            }
        },
        modConfigurations: [],
        javaConfig: {
            [serverId]: {
                minRAM: ram,
                maxRAM: ram,
                executable: javaExec,
                jvmOptions: [
                    '-XX:+UnlockExperimentalVMOptions',
                    '-XX:+UseG1GC',
                    '-XX:G1NewSizePercent=20',
                    '-XX:G1ReservePercent=20',
                    '-XX:MaxGCPauseMillis=50',
                    '-XX:G1HeapRegionSize=32M'
                ]
            }
        }
    }
}

/**
 * Resolve the launcher's userData directory (where config.json lives)
 * from the app metadata, the way Electron names it: %APPDATA%/<productName
 * from package.json>. Falls back to the package name.
 *
 * @param {Object} pkg The parsed package.json.
 * @param {string} appData The %APPDATA% value.
 * @returns {string} The userData path.
 */
function userDataDir(pkg, appData){
    const name = (pkg != null && typeof pkg.productName === 'string' && pkg.productName.length > 0)
        ? pkg.productName
        : pkg.name
    return path.join(appData, name)
}

/* -------------------------------- runner -------------------------------- */

const DEFAULTS = {
    syncTimeoutMs: 18 * 60 * 1000,   // distribution + full client download
    gameTimeoutMs: 20 * 60 * 1000,   // spawn -> title screen (software GL boots slowly)
    pollMs: 2000,
    serverId: 'ImperiumMC',
    uuid: '00000000-0000-0000-0000-000000000000',
    name: 'SmokeTest'
}

/**
 * Drive the smoke run. deps is injectable for the unit tests.
 *
 * @param {Object} options {exe, dataDir, javaHome, mesaDll?, artifactsDir,
 * serverId?, syncTimeoutMs?, gameTimeoutMs?, pollMs?}
 * @param {Object} [deps] {spawnImpl, sleep, now, log}
 * @returns {Promise.<{ok: boolean, reason: string}>}
 */
async function runSmoke(options, deps = {}){
    const spawnImpl = deps.spawnImpl || ((...args) => spawn(...args))
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    const now = deps.now || (() => Date.now())
    const log = deps.log || ((...args) => console.log('[smoke-driver]', ...args))

    const serverId = options.serverId || DEFAULTS.serverId
    const uuid = DEFAULTS.uuid
    const name = DEFAULTS.name
    const javaExec = path.join(options.javaHome, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java')
    const artifactsDir = options.artifactsDir || path.join(ROOT, '.smoke-artifacts')
    const gameDir = path.join(options.dataDir, 'instances', serverId)
    const latestLog = path.join(gameDir, 'logs', 'latest.log')

    fs.mkdirSync(artifactsDir, { recursive: true })

    // 1. Pre-seed the launcher config. userData is wiped first so the run
    //    is always a first launch with exactly this state.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    const uDir = userDataDir(pkg, appData)
    fs.rmSync(uDir, { recursive: true, force: true })
    fs.mkdirSync(uDir, { recursive: true })
    const config = buildSmokeConfig({ serverId, uuid, name, dataDir: options.dataDir, javaExec })
    fs.writeFileSync(path.join(uDir, 'config.json'), JSON.stringify(config, null, 4))
    log(`seeded config at ${path.join(uDir, 'config.json')}`)
    log(`data directory ${options.dataDir}, game dir ${gameDir}`)

    if(!fs.existsSync(javaExec)){
        return { ok: false, reason: `java executable not found at ${javaExec}` }
    }

    // 2. Mesa software GL next to javaw.exe: GitHub runners have no GPU.
    //    Windows loads opengl32.dll from the executable's own directory
    //    before the system one.
    if(options.mesaDll != null){
        if(!fs.existsSync(options.mesaDll)){
            return { ok: false, reason: `mesa dll not found at ${options.mesaDll}` }
        }
        const dest = path.join(path.dirname(javaExec), 'opengl32.dll')
        fs.copyFileSync(options.mesaDll, dest)
        log(`copied mesa opengl32.dll to ${dest}`)
    }

    // 3. Start the launcher headless.
    const launcherOut = fs.openSync(path.join(artifactsDir, 'launcher-stdout.log'), 'w')
    const launcherErr = fs.openSync(path.join(artifactsDir, 'launcher-stderr.log'), 'w')
    let launcherText = ''
    const child = spawnImpl(options.exe, [], {
        env: Object.assign({}, process.env, {
            IMPERIUM_SMOKE_LAUNCH: '1',
            IMPERIUM_SMOKE: '1',
            ELECTRON_ENABLE_LOGGING: '1'
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    })
    log(`spawned launcher pid ${child.pid}`)
    let launcherExited = null
    child.stdout && child.stdout.on('data', (chunk) => {
        launcherText += chunk.toString('utf8')
        fs.writeSync(launcherOut, chunk)
    })
    child.stderr && child.stderr.on('data', (chunk) => {
        fs.writeSync(launcherErr, chunk)
    })
    child.on('exit', (code) => {
        launcherExited = code
        try {
            fs.closeSync(launcherOut)
            fs.closeSync(launcherErr)
        } catch{ /* already closed */ }
    })

    const killTree = deps.kill || (() => {
        if(launcherExited == null && child.pid != null && process.platform === 'win32'){
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'])
        } else if(launcherExited == null && child.kill != null){
            child.kill('SIGKILL')
        }
    })
    const finish = (ok, reason) => {
        killTree()
        return { ok, reason }
    }

    // 4. Phase A: wait for the launcher to spawn the game.
    const syncDeadline = now() + (options.syncTimeoutMs || DEFAULTS.syncTimeoutMs)
    while(now() < syncDeadline){
        if(launcherText.includes('[SMOKE] game spawned')){
            log('game spawned by the launcher')
            break
        }
        if(launcherText.includes('[SMOKE] launch failed') || launcherText.includes('[SMOKE] launch pipeline reported failure')){
            return finish(false, 'launcher reported a launch pipeline failure before spawn')
        }
        if(launcherExited != null){
            return finish(false, `launcher exited with code ${launcherExited} before spawning the game`)
        }
        await sleep(500)
    }
    if(!launcherText.includes('[SMOKE] game spawned')){
        return finish(false, 'timed out waiting for the launcher to spawn the game (sync/download phase)')
    }

    // 5. Phase B: watch the game's own log for the title screen.
    const gameDeadline = now() + (options.gameTimeoutMs || DEFAULTS.gameTimeoutMs)
    let logOffset = 0
    let gameText = ''
    while(now() < gameDeadline){
        if(launcherExited != null && launcherExited !== 0){
            return finish(false, `launcher exited with code ${launcherExited} while the game was running`)
        }
        try {
            const stat = fs.statSync(latestLog)
            if(stat.size > logOffset){
                const handle = fs.openSync(latestLog, 'r')
                try {
                    const buffer = Buffer.alloc(stat.size - logOffset)
                    fs.readSync(handle, buffer, 0, buffer.length, logOffset)
                    gameText += buffer.toString('utf8')
                } finally {
                    fs.closeSync(handle)
                }
                logOffset = stat.size
            }
        } catch{
            // latest.log does not exist until the game creates it.
        }
        const verdict = scanLog(gameText)
        if(verdict.failed){
            return finish(false, `game log matched a failure marker (${verdict.match})`)
        }
        if(verdict.passed){
            log(`game log matched the title-screen marker (${verdict.match})`)
            try {
                fs.copyFileSync(latestLog, path.join(artifactsDir, 'latest.log'))
            } catch{ /* artifact copy is best effort */ }
            return finish(true, 'title screen reached')
        }
        await sleep(options.pollMs || DEFAULTS.pollMs)
    }
    try { fs.copyFileSync(latestLog, path.join(artifactsDir, 'latest.log')) } catch { /* absent */ }
    return finish(false, 'timed out waiting for the title-screen marker in the game log')
}

/* --------------------------------- main --------------------------------- */

function parseArgs(argv){
    const options = {}
    for(let i = 0; i < argv.length; i++){
        const arg = argv[i]
        if(!arg.startsWith('--')){
            continue
        }
        // --kebab-case-keys become camelCase (artifacts-dir -> artifactsDir).
        const key = arg.substring(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())
        const value = argv[i + 1]
        if(value == null || value.startsWith('--')){
            options[key] = true
            continue
        }
        options[key] = value
        i++
    }
    return options
}

// Run as a driver only when executed directly AND not as part of the
// node:test sweep (which loads every file under test/ and would otherwise
// hit the missing-arguments exit).
if(require.main === module && !process.env.NODE_TEST_CONTEXT){
    const args = parseArgs(process.argv.slice(2))
    for(const required of ['exe', 'dataDir', 'javaHome']){
        if(typeof args[required] !== 'string'){
            console.error(`missing required --${required} argument`)
            process.exit(2)
        }
    }
    runSmoke({
        exe: args.exe,
        dataDir: args.dataDir,
        javaHome: args.javaHome,
        mesaDll: args.mesa,
        artifactsDir: args.artifactsDir,
        serverId: args.server
    }).then((result) => {
        console.log(`[smoke-driver] verdict: ${result.ok ? 'PASS' : 'FAIL'} — ${result.reason}`)
        // Give taskkill a moment so the game tree is gone before the
        // runner uploads artifacts.
        setTimeout(() => process.exit(result.ok ? 0 : 1), 5000)
    }).catch((err) => {
        console.error('[smoke-driver] driver crashed:', err)
        process.exit(1)
    })
}

module.exports = {
    PASS_PATTERNS,
    FAIL_PATTERNS,
    scanLog,
    buildSmokeConfig,
    userDataDir,
    runSmoke,
    parseArgs
}
