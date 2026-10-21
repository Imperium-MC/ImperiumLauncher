/**
 * userdatamigration.js — one-time carry-over from the Imperium Launcher
 * userData directory to the rebranded Romanica Launcher one.
 *
 * Electron derives the userData directory from productName, so the rebrand
 * moved it from %APPDATA%\Imperium Launcher to %APPDATA%\Romanica Launcher.
 * Without this copy every existing player surfaces as a first launch:
 * logged out, welcome screen back, distribution cache gone.
 *
 * Runs in the main process BEFORE anything requires configmanager.js —
 * that module resolves config.json at require time — so it is invoked at
 * the top of index.js, ahead of the launcher core. The old directory is
 * COPIED, never moved or deleted: it stays on disk untouched as a backup.
 *
 * What is carried over (the complete set of files the launcher keeps in
 * userData — helios-core caches the distribution index beside the config):
 *   - config.json             accounts, settings, selected server
 *   - distribution.json       cached distribution index
 *   - distribution_dev.json   dev-mode cache, when present
 *
 * Game files are NOT involved: they live under the data directory named
 * in config.json, which is copied verbatim and still points wherever the
 * player installed it.
 *
 * Everything path- and fs-shaped is injectable so the logic runs under
 * plain node (test/userdata-migration.test.js).
 */
'use strict'

const fs = require('fs')
const path = require('path')

// ROMANICA CUTOVER: legacy directory name. Keep until every player has
// booted the rebranded launcher once; after that the constant (and this
// whole module) can be deleted.
const LEGACY_DIR_NAME = 'Imperium Launcher'
const CARRY_OVER_FILES = [
    'config.json',
    'distribution.json',
    'distribution_dev.json'
]

/**
 * Perform the migration against injectable primitives.
 *
 * @param {Object} options
 * @param {string} options.appData the OS app-data root (app.getPath('appData'))
 * @param {string} options.userData the current userData dir (app.getPath('userData'))
 * @param {Function} [options.existsSync] defaults to fs.existsSync
 * @param {Function} [options.copyFileSync] defaults to fs.copyFileSync
 * @param {Function} [options.mkdirSync] defaults to fs.mkdirSync
 * @param {Function} [options.log] defaults to console.log
 * @returns {{migrated: boolean, reason: string, copied: string[], legacyDir: string, targetDir: string}}
 */
exports.migrate = function({
    appData,
    userData,
    existsSync = fs.existsSync,
    copyFileSync = fs.copyFileSync,
    mkdirSync = fs.mkdirSync,
    log = () => {}
} = {}){
    const result = {
        migrated: false,
        reason: '',
        copied: [],
        legacyDir: '',
        targetDir: typeof userData === 'string' ? userData : ''
    }

    if(typeof appData !== 'string' || typeof userData !== 'string'){
        result.reason = 'invalid-paths'
        return result
    }

    result.legacyDir = path.join(appData, LEGACY_DIR_NAME)
    const legacyDir = result.legacyDir

    // The new directory already exists: a previous boot (migrated or fresh)
    // owns it. Never merge into an existing profile.
    if(existsSync(userData)){
        result.reason = 'destination-exists'
        return result
    }

    if(!existsSync(legacyDir)){
        result.reason = 'no-legacy-directory'
        return result
    }

    try {
        mkdirSync(userData, { recursive: true })
        for(const name of CARRY_OVER_FILES){
            const source = path.join(legacyDir, name)
            if(existsSync(source)){
                copyFileSync(source, path.join(userData, name))
                result.copied.push(name)
            }
        }
    } catch(err){
        // A failed copy must never brick startup: ConfigManager falls back
        // to a fresh first-launch configuration. The legacy directory is
        // still intact, so nothing is lost.
        result.reason = 'copy-failed'
        log(`[UserDataMigration] copy failed, starting fresh: ${err && err.message ? err.message : err}`)
        return result
    }

    if(result.copied.length === 0){
        result.reason = 'legacy-directory-empty'
        return result
    }

    result.migrated = true
    result.reason = 'migrated'
    log(`[UserDataMigration] carried ${result.copied.join(', ')} from ${legacyDir} to ${userData} (legacy directory kept as backup)`)
    return result
}

/**
 * Main-process entry point. Resolves the real paths from the electron app
 * and runs the migration. Safe to call on every boot: after the first run
 * the destination exists and it is a no-op.
 */
exports.init = function(){
    // Required lazily so this module stays loadable under plain node in
    // the test suite (the same electron-stub technique used elsewhere).
    const { app } = require('electron')
    exports.migrate({
        appData: app.getPath('appData'),
        userData: app.getPath('userData'),
        log: (msg) => console.log(msg)
    })
}
