const test   = require('node:test')
const assert = require('node:assert')

const { redactText } = require('../app/main/redact')

/**
 * Fixture crash report shaped like a real Minecraft crash-report tail: the
 * three sensitive classes the scrubber exists for (profile paths carrying
 * the Windows username, unexpanded profile env refs, echoed credentials)
 * mixed with the content that must survive verbatim (stack frames, mod
 * ids, error text) because that is the diagnostic value of the report.
 * The same fixture shape is mirrored on the backend half
 * (imperium-backend src/test/crash-text-redaction.test.ts) so both sides
 * prove the same shared rule set from app/main/redact.js.
 */
const FIXTURE_CRASH_REPORT = [
    '---- Minecraft Crash Report ----',
    '// Why did you do that?',
    'Time: 2026-10-21 08:15:30 CET',
    'Description: Rendering overlay',
    '',
    'java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll',
    '\tat org.lwjgl.system.Library.loadSystem(Library.java:177)',
    '\tat net.minecraft.client.main.Main.main(Main.java:1291)',
    '',
    '-- System Details --',
    'Operating System: Windows 11 (amd64) version 10.0.26200',
    'Java Version: 17.0.12, Eclipse Adoptium',
    'Fabric Mods:',
    '    fabric-api 0.116.0+1.21',
    '    sodium 0.6.13+mc1.21.4',
    'Launched Version: RomanicaClient 0.2.0-beta.24',
    'Game Dir: C:\\Users\\MylesThePro\\AppData\\Roaming\\Romanica\\instances\\main',
    'Resource Dir: C:/Users/MylesThePro/AppData/Roaming/Romanica/resources',
    'Mod Path: %APPDATA%\\Romanica\\instances\\main\\mods\\sodium.jar',
    'Profile Root: /Users/MylesThePro/Library/Application Support/Romanica',
    'Server Dir: /home/myles/romanica-server',
    '',
    '-- Auth debug (echoed by a chatty library) --',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'Renewing with refresh_token=8f14e45fceea167a5a36dedd4bea2543ca9a',
    'X-Session header: session token 3f2b9c01a4d8e67f5a0b2c3d4e5f6071 accepted',
    'Microsoft login: client_secret: dZmVkYjE2YTAtYTNlNS00YTNhLTkyZTctYjNkMjg0Y2E1Zjc4',
    'Previous identity was eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3MjM5MjY0MDB9.k2Z9Xx8mQ1vJn3LpQ7wRtYuIOLMbHcSaVd5NfGeE1sA here',
    ''
].join('\n')

test('fixture crash report: usernames in paths are redacted, diagnostics survive', () => {
    const scrubbed = redactText(FIXTURE_CRASH_REPORT)

    // The username never survives, in any of the path spellings.
    assert.ok(!scrubbed.includes('MylesThePro'), 'windows/mac username must not survive')
    assert.ok(!scrubbed.includes('myles'), 'linux username must not survive')
    assert.ok(scrubbed.includes('C:\\Users\\REDACTED\\AppData\\Roaming\\Romanica\\instances\\main'))
    assert.ok(scrubbed.includes('C:/Users/REDACTED/AppData/Roaming/Romanica/resources'))
    assert.ok(scrubbed.includes('/Users/REDACTED/Library/Application Support/Romanica'))
    assert.ok(scrubbed.includes('/home/REDACTED/romanica-server'))
    // The unexpanded profile env ref goes too.
    assert.ok(scrubbed.includes('%REDACTED%\\Romanica\\instances\\main\\mods\\sodium.jar'))
    assert.ok(!scrubbed.includes('%APPDATA%'))

    // Diagnostics survive verbatim: stack frames, mod ids, error text.
    assert.ok(scrubbed.includes('\tat org.lwjgl.system.Library.loadSystem(Library.java:177)'))
    assert.ok(scrubbed.includes('\tat net.minecraft.client.main.Main.main(Main.java:1291)'))
    assert.ok(scrubbed.includes('java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll'))
    assert.ok(scrubbed.includes('fabric-api 0.116.0+1.21'))
    assert.ok(scrubbed.includes('sodium 0.6.13+mc1.21.4'))
    assert.ok(scrubbed.includes('RomanicaClient 0.2.0-beta.24'))
})

test('fixture crash report: bearer/session tokens and labelled secrets are redacted', () => {
    const scrubbed = redactText(FIXTURE_CRASH_REPORT)

    // No credential material survives in any form.
    assert.ok(!scrubbed.includes('eyJhbGciOiJIUzI1NiJ9'), 'bearer JWT must not survive')
    assert.ok(!scrubbed.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'))
    assert.ok(!scrubbed.includes('8f14e45fceea167a5a36dedd4bea2543ca9a'))
    assert.ok(!scrubbed.includes('3f2b9c01a4d8e67f5a0b2c3d4e5f6071'))
    assert.ok(!scrubbed.includes('dZmVkYjE2YTAtYTNlNS00YTNhLTkyZTctYjNkMjg0Y2E1Zjc4'))
    assert.ok(!scrubbed.includes('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9'), 'bare JWT must not survive')

    // ...but the labels do, so the log still says WHAT leaked there.
    assert.ok(scrubbed.includes('Authorization: Bearer [REDACTED]'))
    assert.ok(scrubbed.includes('refresh_token=[REDACTED]'))
    assert.ok(scrubbed.includes('session token [REDACTED] accepted'))
    assert.ok(scrubbed.includes('client_secret: [REDACTED]'))
    assert.ok(scrubbed.includes('Previous identity was [REDACTED] here'))
})

test('fixture crash report: redaction is idempotent (a second pass is a no-op)', () => {
    const once = redactText(FIXTURE_CRASH_REPORT)
    assert.strictEqual(redactText(once), once)
})

test('path rules: drive letters, lowercase users, quoted JSON and already-redacted input', () => {
    assert.strictEqual(redactText('D:\\users\\bob\\mods\\x.jar'), 'D:\\users\\REDACTED\\mods\\x.jar')
    assert.strictEqual(redactText('loading "C:\\Users\\Ann-Marie.S\\config.json" now'),
        'loading "C:\\Users\\REDACTED\\config.json" now')
    assert.strictEqual(redactText('path C:\\Users\\john: failed'), 'path C:\\Users\\REDACTED: failed')
    // Already redacted: unchanged.
    assert.strictEqual(redactText('C:\\Users\\REDACTED\\AppData\\Roaming'), 'C:\\Users\\REDACTED\\AppData\\Roaming')
    // A URL path is not a home directory.
    assert.strictEqual(redactText('see https://example.com/home/page for details'),
        'see https://example.com/home/page for details')
})

test('token rules: separator forms and the length floor', () => {
    assert.strictEqual(redactText('password=hunter2hunter2hunter2'), 'password=[REDACTED]')
    assert.strictEqual(redactText('"access_token": "c3VwZXJzZWNyZXR2YWx1ZTEyMzQ1"'),
        '"access_token": "[REDACTED]"')
    assert.strictEqual(redactText('api-key 0123456789abcdef0123456789abcdef rejected'),
        'api-key [REDACTED] rejected')
    assert.strictEqual(redactText('Authorization: bearer abcdefghijklmnopqrstuvwxyz123456'),
        'Authorization: bearer [REDACTED]')
    // Short values below the 16-char floor are ordinary words, not secrets.
    assert.strictEqual(redactText('password incorrect, try again'), 'password incorrect, try again')
})

test('bare digests, uuids and addresses are diagnostic value and survive', () => {
    const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    assert.strictEqual(redactText(`sha256 ${digest}`), `sha256 ${digest}`)
    const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5'
    assert.strictEqual(redactText(`--uuid ${uuid}`), `--uuid ${uuid}`)
    assert.strictEqual(redactText('connected to 198.51.100.7:25565'), 'connected to 198.51.100.7:25565')
})

test('non-string and empty input pass through untouched', () => {
    assert.strictEqual(redactText(''), '')
    assert.strictEqual(redactText(null), null)
    assert.strictEqual(redactText(undefined), undefined)
    assert.strictEqual(redactText(42), 42)
})
