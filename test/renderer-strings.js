/**
 * Renderer string-handling audit and external link policy tests.
 *
 * Plain node, no DOM required:  node test/renderer-strings.js
 *
 * Two halves:
 *  1. Behavioral tests for the pure parts of the sanitizing wrapper
 *     (isAllowedLink, fail-closed sanitizeHtml).
 *  2. A grep audit over app/assets/js asserting that no innerHTML
 *     assignment survives outside an explicit allowlist. The test
 *     FAILS if someone reintroduces an innerHTML write, so any new
 *     assignment must be either textContent/DOM building or be added
 *     here with a static-trusted justification.
 */
const fs   = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const { isAllowedLink, sanitizeHtml } = require(path.join(ROOT, 'app', 'assets', 'js', 'newsSanitize.js'))

const failures = []
const passes   = []

function check(name, condition, detail){
    if(condition){
        passes.push(name)
    } else {
        failures.push(detail ? `${name} — ${detail}` : name)
    }
}

/* ------------------------------------------------------------------ */
/* 1. External link policy                                             */
/* ------------------------------------------------------------------ */

const ALLOWED_URLS = [
    'https://imperiummc.net/news.rss',
    'https://imperiummc.net/',
    'https://www.imperiummc.net/news.rss',
    'https://github.com/Imperium-MC/ImperiumLauncher/releases',
    'https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html',
    'https://minecraft.net/'
]
for(const url of ALLOWED_URLS){
    check(`isAllowedLink accepts ${url}`, isAllowedLink(url) === true, 'expected allowed')
}

const REJECTED_URLS = [
    'http://imperiummc.net/news.rss',                       // not https
    'https://evil.com/',                                    // foreign host
    'https://imperiummc.net.evil.com/',                     // suffix spoof
    'https://evilimperiummc.net/',                          // suffix spoof
    'javascript:alert(1)',                                  // scheme
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'file:///C:/Windows/System32/calc.exe',
    'imperiummc.net/news.rss',                              // relative/no scheme
    '//imperiummc.net/news.rss',                            // protocol relative
    'https://user:pass@imperiummc.net/',                    // userinfo
    '',                                                     // empty
    'https://imperiummc.net/\u0000'
]
for(const url of REJECTED_URLS){
    check(`isAllowedLink rejects ${JSON.stringify(url)}`, isAllowedLink(url) === false, 'expected rejected')
}
for(const value of [null, undefined, 123, {}, []]){
    check(`isAllowedLink rejects non-string ${JSON.stringify(value)}`, isAllowedLink(value) === false, 'expected rejected')
}

/* ------------------------------------------------------------------ */
/* 2. Sanitizer fail-closed behavior (no DOM in this process)          */
/* ------------------------------------------------------------------ */

check(
    'sanitizeHtml fails closed without a DOM',
    sanitizeHtml('<p>hello</p><img src=x onerror=alert(1)>') === '',
    'sanitizeHtml must return empty string when DOMPurify cannot initialize'
)

/* ------------------------------------------------------------------ */
/* 3. Dependency declared                                              */
/* ------------------------------------------------------------------ */

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
check(
    'dompurify is a declared dependency',
    pkg.dependencies != null && typeof pkg.dependencies.dompurify === 'string',
    'package.json dependencies.dompurify missing'
)
check(
    'dompurify is installed',
    fs.existsSync(path.join(ROOT, 'node_modules', 'dompurify', 'package.json')),
    'node_modules/dompurify missing — run npm install'
)

/* ------------------------------------------------------------------ */
/* 4. innerHTML assignment audit                                       */
/* ------------------------------------------------------------------ */

/**
 * Every innerHTML write that is allowed to exist, with the reason it
 * cannot carry external data. Anything not listed here fails the audit.
 */
const INNERHTML_ALLOWLIST = [
    {
        file: 'app/assets/js/newsSanitize.js',
        fragment: 'element.innerHTML = exports.sanitizeHtml(html)',
        reason: 'the single sanitized-markup sink; input has passed the DOMPurify allowlist'
    },
    {
        file: 'app/assets/js/scripts/settings.js',
        fragment: 'settingsUpdateActionButton.innerHTML = text',
        reason: 'language strings only (every settingsUpdateButtonStatus call site passes Lang.queryJS output); the darwin download label ships a styled span'
    },
    {
        file: 'app/assets/js/scripts/overlay.js',
        fragment: 'document.getElementById(\'overlayAcknowledge\').innerHTML = acknowledge',
        reason: 'language strings only; every setOverlayContent call site passes Lang.queryJS output for the button labels'
    },
    {
        file: 'app/assets/js/scripts/overlay.js',
        fragment: 'document.getElementById(\'overlayDismiss\').innerHTML = dismiss',
        reason: 'language strings only; default is Lang.queryJS(\'overlay.dismiss\') and all overrides are Lang output'
    }
]

function listJsFiles(dir){
    const out = []
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
        // Vendored third-party builds (jquery, DOMPurify) ship as minified
        // browser bundles; they are upstream code, not launcher code, and
        // are outside the scope of this audit.
        if(entry.isDirectory() && entry.name === 'vendor'){
            continue
        }
        const full = path.join(dir, entry.name)
        if(entry.isDirectory()){
            out.push(...listJsFiles(full))
        } else if(entry.isFile() && entry.name.endsWith('.js')){
            out.push(full)
        }
    }
    return out
}

const jsDir = path.join(ROOT, 'app', 'assets', 'js')
const assignmentRegex = /\.innerHTML\s*(?:\+?=)/g

let auditedAssignments = 0
for(const file of listJsFiles(jsDir)){
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/)
    lines.forEach((line, idx) => {
        // Reset lastIndex — the regex object is shared across iterations.
        assignmentRegex.lastIndex = 0
        if(assignmentRegex.test(line)){
            auditedAssignments++
            const allowed = INNERHTML_ALLOWLIST.some(entry => entry.file === rel && line.includes(entry.fragment))
            check(
                `innerHTML assignment allowed at ${rel}:${idx + 1}`,
                allowed,
                `unexpected innerHTML write "${line.trim()}"`
            )
        }
    })
}
check('audit found innerHTML assignments (scanner sanity)', auditedAssignments >= INNERHTML_ALLOWLIST.length,
    `expected at least ${INNERHTML_ALLOWLIST.length} assignments, saw ${auditedAssignments}`)

/* ------------------------------------------------------------------ */
/* 5. Structural checks on the hardened code paths                     */
/* ------------------------------------------------------------------ */

function read(rel){
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8')
}

const landing = read('app/assets/js/scripts/landing.js')
check('landing player count is coerced numerically',
    landing.includes('Number.isFinite') && landing.includes('formatPlayerCount'),
    'player count must go through a Number.isFinite coercion')
check('landing player count written as text',
    /player_count'\)\.textContent/.test(landing),
    'player_count element must be written via textContent')
check('news article fields written as text',
    /newsArticleTitle\.textContent/.test(landing) && /newsArticleDate\.textContent/.test(landing) && /newsArticleComments\.textContent/.test(landing),
    'news title/date/comments must be written via textContent')
check('news article content is sanitized',
    landing.includes('setSanitizedHtml(body, articleObject.content)'),
    'article content must pass through setSanitizedHtml')
check('news article content never concatenated into markup',
    !landing.includes('+ articleObject.content'),
    'article content must not be concatenated into an HTML string')
check('news article links gated by the link policy',
    landing.includes('setArticleLink(newsArticleTitle, articleObject.link)') &&
    landing.includes('setArticleLink(newsArticleComments, articleObject.commentsLink)') &&
    landing.includes('function setArticleLink') && landing.includes('if(NewsSanitize.isAllowedLink(url))'),
    'article link/comment targets must pass isAllowedLink before being assigned')

const overlay = read('app/assets/js/scripts/overlay.js')
check('overlay title/desc sanitized at the sink',
    overlay.includes('setSanitizedHtml(document.getElementById(\'overlayTitle\'), title)') &&
    overlay.includes('setSanitizedHtml(document.getElementById(\'overlayDesc\'), description)'),
    'overlay title and description must pass through setSanitizedHtml')

const uicore = read('app/assets/js/scripts/uicore.js')
check('renderer no longer calls shell.openExternal directly for links',
    !uicore.includes('shell.openExternal(this.href)'),
    'external links must be routed through the validated IPC channel')

const main = read('index.js')
check('main window blocks in-window navigation',
    main.includes('will-navigate') && main.includes('event.preventDefault()'),
    'main window must preventDefault on will-navigate')
check('main window denies window.open',
    main.includes('setWindowOpenHandler') && main.includes('{ action: \'deny\' }'),
    'main window must deny setWindowOpenHandler')
check('openExternal IPC handler validates the URL',
    main.includes('SHELL_OPCODE.OPEN_EXTERNAL') && main.includes('isAllowedLink(url)'),
    'the OPEN_EXTERNAL handler must gate on isAllowedLink')

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

console.log(`renderer-strings: ${passes.length} passed, ${failures.length} failed`)
for(const failure of failures){
    console.error(`  FAIL ${failure}`)
}
if(failures.length > 0){
    process.exit(1)
}
