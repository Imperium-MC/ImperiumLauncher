/**
 * managedmodcleanup.js — reaps launcher-managed mod versions that fell out
 * of the distribution (issue #14, task 1).
 *
 * The launcher downloads every FabricMod into common/mods/fabric/<maven
 * path> and every ForgeMod/LiteMod into common/modstore/<maven path>. Those
 * two subtrees are launcher territory: user-added ("drop-in") mods live in
 * the instance directory, never here. Until now nothing ever removed an old
 * version, so every release the launcher ever fetched (beta.5 ... beta.23,
 * plus the pre-#14 "...-undefined.jar" files) piled up side by side.
 *
 * Provenance — how "launcher-managed" is decided (in order):
 *
 *   1. The manifest (common/managed-modules.json). After every successful
 *      sync this module rewrites it with the paths the distribution just
 *      referenced. A file listed there was installed by the launcher.
 *   2. Adoption, which makes the tracker backward compatible with installs
 *      from before the manifest existed: a file inside a managed root whose
 *      full path matches helios-core's deterministic maven layout
 *      (group.../artifact/version/artifact-version[-classifier].jar) — or
 *      the "undefined" variant that layout produced for two-component ids
 *      before issue #14 (group.../X/undefined/X-undefined.jar) — could only
 *      have been placed by the launcher's own sync.
 *
 * Anything else (a jar dropped loose into the subtree, a renamed file, a
 * ".disabled" toggle, anything the shape does not recognize) is treated as
 * the player's and is never touched. When in doubt, the file stays.
 *
 * A file is deleted only when it is provably managed (1 or 2 above) AND not
 * referenced by ANY server of the current distribution. Because this runs
 * after a fully successful sync, the active version is already hash-verified
 * on disk before any stale sibling is removed. All failures are logged and
 * skipped — cleanup must never break a launch — so a locked file (game
 * running) simply gets retried on the next sync.
 */
const fs   = require('fs-extra')
const path = require('path')

const { LoggerUtil } = require('helios-core')

const log = LoggerUtil.getLogger('ManagedModCleanup')

/**
 * Subtrees of the common directory that exclusively hold launcher-installed
 * module files. Everything helios-core resolves elsewhere is excluded on
 * purpose: "libraries" is shared with Mojang's own artifacts, "versions"
 * holds version manifests, and File-type modules live in the instance
 * directory the player can edit.
 */
const MANAGED_ROOTS = [
    path.join('mods', 'fabric'), // Type.FabricMod
    path.join('modstore')        // Type.ForgeMod / Type.LiteMod
]

/** Manifest of launcher-managed files, kept beside them in the common dir. */
const MANIFEST_FILE = 'managed-modules.json'
const MANIFEST_VERSION = 1

/**
 * helios-core's maven layout: [group dirs/]<artifact>/<version>/<artifact>-<version>[-classifier].<ext>
 * Captures the artifact (\2) and version (\3) dirs so the file name can be
 * cross-checked against them.
 */
const MAVEN_LAYOUT_REGEX = /^(?:(.+)\/)?([^/]+)\/([^/]+)\/\2-\3(?:-[^/]+)?\.[a-z0-9]+$/i

/**
 * The layout produced before issue #14 for two-component ids, where
 * helios-core rendered the missing version as "undefined":
 * [group dirs/]<artifact>/undefined/<artifact>-undefined.jar
 */
const UNDEFINED_LAYOUT_REGEX = /^(?:(.+)\/)?([^/]+)\/undefined\/\2-undefined\.jar$/i

/**
 * Does a managed-root-relative path have the exact shape the launcher's
 * sync writes? Anything looser and we might eat a player's file.
 *
 * @param {string} relPosix Path relative to the managed root, forward slashes.
 * @returns {boolean} True when only the launcher could have written it.
 */
function isManagedLayout(relPosix) {
    if(relPosix == null || relPosix.length === 0) {
        return false
    }
    if(UNDEFINED_LAYOUT_REGEX.test(relPosix)) {
        // Segments are [..., X, 'undefined', 'X-undefined.jar']: X must be a
        // real component, not another stray "undefined".
        const artifact = relPosix.split('/').slice(-3, -2)[0]
        return artifact !== 'undefined' && artifact !== ''
    }
    return MAVEN_LAYOUT_REGEX.test(relPosix)
}

/**
 * Normalize a path to forward slashes for stable manifest keys.
 *
 * @param {string} p Any path.
 * @returns {string} POSIX-style path.
 */
function toPosix(p) {
    return p.split(path.sep).join('/')
}

/**
 * Is `child` inside `parent` (and not equal to it)?
 *
 * @param {string} parent Absolute parent directory.
 * @param {string} child Absolute candidate path.
 * @returns {boolean} Containment verdict.
 */
function isInside(parent, child) {
    const rel = path.relative(path.resolve(parent), path.resolve(child))
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Walk a HeliosDistribution and collect the local paths of every module
 * (including sub-modules, of every server) that helios resolves into one of
 * the managed roots. Multi-server unions matter: a file still referenced by
 * server B must never be reaped while syncing server A.
 *
 * @param {Object} distribution A HeliosDistribution instance.
 * @param {string} commonDir The absolute common directory.
 * @returns {Set.<string>} Absolute referenced paths.
 */
function collectReferencedPaths(distribution, commonDir) {
    const referenced = new Set()
    const managedRoots = MANAGED_ROOTS.map(root => path.resolve(commonDir, root))
    const walk = (modules) => {
        for(const module of modules ?? []) {
            const modulePath = path.resolve(module.getPath())
            if(managedRoots.some(root => isInside(root, modulePath))) {
                referenced.add(modulePath)
            }
            walk(module.subModules)
        }
    }
    for(const server of distribution.servers ?? []) {
        walk(server.modules)
    }
    return referenced
}

/**
 * Load the provenance manifest written by the previous successful sync.
 * A missing or corrupt manifest simply starts provenance from scratch
 * (adoption still covers pre-manifest installs).
 *
 * @param {string} commonDir The absolute common directory.
 * @returns {Set.<string>} Absolute paths of recorded managed files.
 */
async function loadManifest(commonDir) {
    const manifestPath = path.join(commonDir, MANIFEST_FILE)
    try {
        const body = await fs.readJson(manifestPath)
        const files = Array.isArray(body?.files) ? body.files : []
        return new Set(files.map(rel => path.resolve(commonDir, rel)))
    } catch(err) {
        if(err.code !== 'ENOENT') {
            log.warn(`Could not read ${manifestPath}; starting provenance from adoption only.`, err.message)
        }
        return new Set()
    }
}

/**
 * Persist the manifest: the files the current distribution references, so
 * the next sync knows exactly what it owns. Written via temp + rename so a
 * crash can never leave a half-written manifest behind.
 *
 * @param {string} commonDir The absolute common directory.
 * @param {Set.<string>} referenced Absolute referenced paths.
 * @returns {Promise.<void>}
 */
async function writeManifest(commonDir, referenced) {
    const manifestPath = path.join(commonDir, MANIFEST_FILE)
    const tmpPath = `${manifestPath}.tmp`
    const body = {
        version: MANIFEST_VERSION,
        generatedAt: new Date().toISOString(),
        files: [...referenced].map(p => toPosix(path.relative(commonDir, p))).sort()
    }
    await fs.writeJson(tmpPath, body, { spaces: 2 })
    await fs.move(tmpPath, manifestPath, { overwrite: true })
}

/**
 * Find files inside the managed roots that match the launcher's deterministic
 * layout. These are adopted as launcher-managed even without a manifest
 * entry, which is what cleans up installs from before provenance existed.
 *
 * @param {string} commonDir The absolute common directory.
 * @param {Set.<string>} known Absolute paths already accounted for.
 * @returns {Promise.<string[]>} Absolute adopted paths.
 */
async function adoptUnrecordedManagedFiles(commonDir, known) {
    const adopted = []
    for(const root of MANAGED_ROOTS) {
        const rootAbs = path.resolve(commonDir, root)
        if(!(await fs.pathExists(rootAbs))) {
            continue
        }
        // Manual walk (fs.walk needs a stream; the trees are tiny).
        const visit = async (dir) => {
            const entries = await fs.readdir(dir, { withFileTypes: true })
            for(const entry of entries) {
                const full = path.join(dir, entry.name)
                if(entry.isDirectory()) {
                    await visit(full)
                } else if(entry.isFile()) {
                    const abs = path.resolve(full)
                    if(known.has(abs)) {
                        continue
                    }
                    if(isManagedLayout(toPosix(path.relative(rootAbs, abs)))) {
                        adopted.push(abs)
                    }
                }
            }
        }
        await visit(rootAbs)
    }
    return adopted
}

/**
 * Remove now-empty directories up from a deleted file, never rising above
 * the managed root. rmdir refuses non-empty directories, so a sibling file
 * stops the prune by itself.
 *
 * @param {string} filePath Absolute path of the just-deleted file.
 * @param {string} rootAbs Absolute managed root containing it.
 * @returns {Promise.<void>}
 */
async function pruneEmptyDirs(filePath, rootAbs) {
    let dir = path.dirname(path.resolve(filePath))
    const stop = path.resolve(rootAbs)
    while(isInside(stop, dir)) {
        try {
            await fs.rmdir(dir)
        } catch(_err) {
            return // not empty (or locked): leave the tree alone
        }
        dir = path.dirname(dir)
    }
}

/**
 * Reap launcher-managed mod files that the current distribution no longer
 * references. Runs after a fully successful sync; every failure is logged
 * and skipped so cleanup can never take the launch down with it.
 *
 * @param {Object} distribution A HeliosDistribution instance.
 * @param {string} commonDir The absolute common directory.
 * @returns {Promise.<Object>} { removed, kept, adopted } — removed/adopted
 * are absolute path arrays, kept is the size of the referenced set.
 */
async function reapStaleManagedModules(distribution, commonDir) {
    const referenced = collectReferencedPaths(distribution, commonDir)

    // Provably-managed files = recorded in the manifest OR matching the
    // launcher's deterministic layout. Everything else is the player's.
    const recorded = await loadManifest(commonDir)
    const known = new Set([...referenced, ...recorded])
    const adopted = await adoptUnrecordedManagedFiles(commonDir, known)

    const rootAbs = MANAGED_ROOTS.map(root => path.resolve(commonDir, root))
    const stale = [...recorded, ...adopted]
        .map(p => path.resolve(p))
        .filter(p => !referenced.has(p))
        .filter(p => rootAbs.some(root => isInside(root, p)))

    const removed = []
    for(const file of stale) {
        try {
            const stat = await fs.stat(file)
            if(!stat.isFile()) {
                continue
            }
            await fs.remove(file)
            removed.push(file)
            for(const root of rootAbs) {
                if(isInside(root, file)) {
                    await pruneEmptyDirs(file, root)
                }
            }
        } catch(err) {
            if(err.code === 'ENOENT') {
                continue // already gone (e.g. profile moved): nothing to do
            }
            log.warn(`Could not remove stale managed file ${file}; it will be retried on the next sync.`, err.message)
        }
    }

    const adoptedRemoved = removed.filter(file => adopted.includes(file)).length
    log.info(`Managed mod cleanup: ${removed.length} stale file(s) removed (${adoptedRemoved} adopted by layout, ${removed.length - adoptedRemoved} from the manifest), ${referenced.size} referenced file(s) kept.`)

    try {
        await writeManifest(commonDir, referenced)
    } catch(err) {
        log.warn('Could not write the managed-modules manifest; next sync will re-derive provenance by adoption.', err.message)
    }

    return { removed, adopted, kept: referenced.size }
}

exports.reapStaleManagedModules = reapStaleManagedModules
exports.isManagedLayout = isManagedLayout
exports.MANAGED_ROOTS = MANAGED_ROOTS
exports.MANIFEST_FILE = MANIFEST_FILE
