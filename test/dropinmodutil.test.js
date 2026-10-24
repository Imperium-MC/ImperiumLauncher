const test   = require('node:test')
const assert = require('node:assert')
const fs     = require('fs-extra')
const os     = require('os')
const path   = require('path')

const { stubModule } = require('./helpers/stubs')
stubModule('electron', { shell: {} })

const DropinModUtil = require('../app/assets/js/dropinmodutil')

async function modsDir(t){
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'romanica-dropin-'))
    t.after(() => fs.remove(root))
    const dir = path.join(root, 'mods')
    await fs.ensureDir(dir)
    return dir
}

test('enabling an already-enabled mod is rejected and never renames the mods folder', async (t) => {
    const dir = await modsDir(t)
    await fs.writeFile(path.join(dir, 'example.jar'), 'jar')

    await assert.rejects(DropinModUtil.toggleDropinMod(dir, 'example.jar', true))

    assert.ok(await fs.pathExists(dir), 'mods folder still exists')
    assert.ok(!await fs.pathExists(dir + '.disabled'), 'mods folder was not renamed')
    assert.ok(await fs.pathExists(path.join(dir, 'example.jar')))
})

test('enabling only strips a trailing .disabled, never one mid-name', async (t) => {
    const dir = await modsDir(t)
    await fs.writeFile(path.join(dir, 'tweaks.disabled-fix.jar'), 'jar')

    await assert.rejects(DropinModUtil.toggleDropinMod(dir, 'tweaks.disabled-fix.jar', true))
    assert.deepStrictEqual(await fs.readdir(dir), ['tweaks.disabled-fix.jar'], 'the mod keeps its name')
})

test('disabling an already-disabled mod is rejected', async (t) => {
    const dir = await modsDir(t)
    await fs.writeFile(path.join(dir, 'example.jar.disabled'), 'jar')

    await assert.rejects(DropinModUtil.toggleDropinMod(dir, 'example.jar.disabled', false))
    assert.ok(await fs.pathExists(path.join(dir, 'example.jar.disabled')))
    assert.ok(!await fs.pathExists(path.join(dir, 'example.jar.disabled.disabled')))
})

test('toggling still works both ways', async (t) => {
    const dir = await modsDir(t)
    await fs.writeFile(path.join(dir, 'example.jar'), 'jar')

    await DropinModUtil.toggleDropinMod(dir, 'example.jar', false)
    assert.ok(await fs.pathExists(path.join(dir, 'example.jar.disabled')))

    await DropinModUtil.toggleDropinMod(dir, 'example.jar.disabled', true)
    assert.ok(await fs.pathExists(path.join(dir, 'example.jar')))
})
