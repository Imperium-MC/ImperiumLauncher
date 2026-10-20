const test   = require('node:test')
const assert = require('node:assert')
const fs     = require('fs')
const path   = require('path')

const ROOT = path.join(__dirname, '..')

function read(rel){
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8')
}

function listFiles(dir, suffix){
    const out = []
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
        const full = path.join(dir, entry.name)
        if(entry.isDirectory()){
            out.push(...listFiles(full, suffix))
        } else if(entry.isFile() && entry.name.endsWith(suffix)){
            out.push(full)
        }
    }
    return out
}

/* ------------------------------------------------------------------ */
/* The preload exposes exactly the allowlisted bridge keys            */
/* ------------------------------------------------------------------ */

const ALLOWED_BRIDGE_KEYS = [
    'env', 'appVersion',
    'setProgressBar', 'windowClose', 'windowMinimize', 'windowToggleMaximize', 'toggleDevTools',
    'clipboardWriteText', 'openExternal', 'trashItem', 'openPath', 'pathForFile',
    'showOpenDialog',
    'configApply', 'configSave', 'configRefresh',
    'distroSummary', 'distroRefresh',
    'serverStatus', 'mojangStatus',
    'authAddMojang', 'authAddMicrosoft', 'authRemoveMojang', 'authRemoveMicrosoft', 'authValidateSelected',
    'javaScan', 'javaDownload', 'javaValidate', 'launchPrepare', 'launch',
    'modsScan', 'modsToggle', 'modsAdd', 'shadersScan', 'shaderSet',
    'log',
    'crashReportUpload',
    'autoUpdateAction', 'onAutoUpdateNotification',
    'msftOpenLogin', 'msftOpenLogout', 'onMsftReplyLogin', 'onMsftReplyLogout',
    'onDistroReady', 'onDevtoolsOpened', 'onLaunchEvent', 'onCrashReport'
]

test('preload exposes exactly the allowlisted bridge keys', () => {
    const preload = read('app/preload.js')

    const start = preload.indexOf('contextBridge.exposeInMainWorld(\'imperium\', {')
    const end = preload.indexOf('})', start)
    assert.notStrictEqual(start, -1, 'exposeInMainWorld(\'imperium\', ...) not found')
    const body = preload.substring(start, end)

    // Collect keys: lines like `name: (` or `name,` at the bridge top level.
    const keys = new Set()
    for(const line of body.split(/\r?\n/)){
        const match = /^\s{4}(?:\/\*[^*]*\*\/\s*)?([A-Za-z_$][\w$]*)\s*(?::|,)/.exec(line)
        if(match){
            keys.add(match[1])
        }
    }

    const expected = new Set(ALLOWED_BRIDGE_KEYS)
    assert.deepStrictEqual([...keys].sort(), [...expected].sort(),
        'the exposed bridge keys must match the allowlist exactly')
})

test('preload requires only electron', () => {
    const preload = read('app/preload.js')
    const requires = [...preload.matchAll(/require\((['"])(.+?)\1\)/g)].map(m => m[2])
    assert.ok(requires.length > 0, 'preload must require electron')
    for(const target of requires){
        assert.strictEqual(target, 'electron', `preload must not require anything but electron (saw ${target})`)
    }
})

/* ------------------------------------------------------------------ */
/* No @electron/remote anywhere                                        */
/* ------------------------------------------------------------------ */

test('no @electron/remote require remains in app code or index.js', () => {
    const files = [...listFiles(path.join(ROOT, 'app'), '.js'), path.join(ROOT, 'index.js')]
    for(const file of files){
        const content = fs.readFileSync(file, 'utf-8')
        assert.ok(!/require\(\s*(['"])@electron\/remote/.test(content),
            `${path.relative(ROOT, file)} still requires @electron/remote`)
    }
})

test('@electron/remote is not a declared dependency', () => {
    const pkg = JSON.parse(read('package.json'))
    assert.strictEqual(pkg.dependencies['@electron/remote'], undefined,
        'package.json must not depend on @electron/remote')
})

test('renderer scripts contain no node requires', () => {
    const scripts = listFiles(path.join(ROOT, 'app', 'assets', 'js', 'scripts'), '.js')
    assert.ok(scripts.length > 0, 'renderer scripts not found')
    for(const file of scripts){
        const content = fs.readFileSync(file, 'utf-8')
        assert.ok(!/\brequire\s*\(\s*['"]/.test(content),
            `${path.relative(ROOT, file)} must not use require() (sandboxed renderer)`)
    }
})

test('renderer scripts contain no ipcRenderer or node globals', () => {
    const scripts = listFiles(path.join(ROOT, 'app', 'assets', 'js', 'scripts'), '.js')
    for(const file of scripts){
        const content = fs.readFileSync(file, 'utf-8')
        assert.ok(!/\bipcRenderer\b/.test(content),
            `${path.relative(ROOT, file)} must not touch ipcRenderer directly`)
        assert.ok(!/\bprocess\.platform\b/.test(content),
            `${path.relative(ROOT, file)} must not read process.platform (use Imperium.env.platform)`)
    }
})

/* ------------------------------------------------------------------ */
/* Main window hardening                                               */
/* ------------------------------------------------------------------ */

test('main window webPreferences isolate the renderer', () => {
    const main = read('index.js')
    const start = main.indexOf('webPreferences: {')
    const end = main.indexOf('}', start)
    assert.notStrictEqual(start, -1, 'webPreferences block not found')
    const block = main.substring(start, end)
    assert.ok(block.includes('contextIsolation: true'), 'contextIsolation must be true')
    assert.ok(block.includes('nodeIntegration: false'), 'nodeIntegration must be false')
    assert.ok(block.includes('sandbox: true'), 'sandbox must be true')
})

test('main process loads the new preload', () => {
    const main = read('index.js')
    assert.ok(main.includes('\'app\', \'preload.js\''),
        'index.js must point at app/preload.js')
    assert.ok(!main.includes('preloader.js'),
        'the old renderer preloader must not be wired up')
})

/* ------------------------------------------------------------------ */
/* Content security policy                                             */
/* ------------------------------------------------------------------ */

test('CSP meta tag present with the expected policy', () => {
    const appEjs = read('app/app.ejs')
    const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(appEjs)
    assert.notStrictEqual(match, null, 'app.ejs must carry a CSP meta tag')
    const policy = match[1]

    assert.ok(policy.includes('default-src \'self\''), 'CSP must default to self')
    assert.ok(policy.includes('script-src \'self\''), 'script-src must be self')
    assert.ok(policy.includes('style-src \'self\' \'unsafe-inline\''), 'style-src must allow the shipped inline styles')
    assert.ok(policy.includes('img-src \'self\' https: data:'), 'img-src must cover https avatars and data uris')
    assert.ok(policy.includes('connect-src \'self\' https://imperiummc.net https://github.com'),
        'connect-src must be scoped to the feeds the renderer fetches')
    assert.ok(!policy.includes('unsafe-eval'), 'CSP must not allow unsafe-eval')
})

test('renderer network fetches stay within the CSP connect-src', () => {
    const scripts = listFiles(path.join(ROOT, 'app', 'assets', 'js'), '.js')
    const allowed = new Set(['imperiummc.net', 'github.com'])
    const urlRegex = /https:\/\/([a-z0-9.-]+)\//g
    for(const file of scripts){
        const rel = path.relative(ROOT, file).split(path.sep).join('/')
        if(rel === 'app/assets/js/distromanager.js' || rel === 'app/assets/js/ipcconstants.js' || rel === 'app/assets/js/assetdl.js' || rel === 'app/assets/js/processbuilder.js' || rel === 'app/assets/js/crashscreen.js' || rel === 'app/assets/js/authmanager.js'){
            // Main-process modules; their network access is not constrained by the page CSP.
            continue
        }
        const content = fs.readFileSync(file, 'utf-8')
        for(const m of content.matchAll(urlRegex)){
            const host = m[1]
            const ok = [...allowed].some(a => host === a || host.endsWith('.' + a)) || host.startsWith('docs.oracle.com') || host.startsWith('login.microsoftonline') || host.startsWith('mc-heads.net')
            // docs.oracle / microsoft / mc-heads appear only as link targets or
            // image sources, never as fetch() hosts; anything else must be flagged.
            assert.ok(ok, `${rel} references https://${host} which is outside the page CSP connect-src`)
        }
    }
})

/* ------------------------------------------------------------------ */
/* Vendored browser builds exist                                       */
/* ------------------------------------------------------------------ */

test('vendored jquery and dompurify browser builds exist', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'app', 'assets', 'js', 'vendor', 'jquery.min.js')),
        'vendor/jquery.min.js missing')
    assert.ok(fs.existsSync(path.join(ROOT, 'app', 'assets', 'js', 'vendor', 'purify.min.js')),
        'vendor/purify.min.js missing')
})

test('app.ejs loads the bridge and vendor scripts before the UI scripts', () => {
    const appEjs = read('app/app.ejs')
    const order = [
        'vendor/jquery.min.js',
        'vendor/purify.min.js',
        'assets/js/newsSanitize.js',
        'assets/js/renderutil.js',
        'assets/js/scripts/bridge.js',
        'assets/js/scripts/uicore.js',
        'assets/js/scripts/uibinder.js'
    ]
    let last = -1
    for(const src of order){
        const idx = appEjs.indexOf(src)
        assert.notStrictEqual(idx, -1, `app.ejs must load ${src}`)
        assert.ok(idx > last, `app.ejs script order wrong at ${src}`)
        last = idx
    }
})
