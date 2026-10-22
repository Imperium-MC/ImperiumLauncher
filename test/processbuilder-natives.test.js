const test   = require('node:test')
const assert = require('node:assert')
const AdmZip = require('adm-zip')
const fs     = require('fs-extra')
const os     = require('os')
const path   = require('path')

// processbuilder.js requires ./configmanager, which needs @electron/remote at
// module load time. Seed the module cache with a stub so the file loads
// outside the renderer. Nothing under test touches ConfigManager.
const configManagerPath = path.resolve(__dirname, '..', 'app', 'assets', 'js', 'configmanager.js')
require.cache[configManagerPath] = {
    id: configManagerPath,
    filename: configManagerPath,
    loaded: true,
    exports: {
        getInstanceDirectory: () => path.join(os.tmpdir(), 'imperiumlauncher-test-instances'),
        getCommonDirectory: () => path.join(os.tmpdir(), 'imperiumlauncher-test-common'),
        getTempNativeFolder: () => 'WCNativesTest'
    }
}

const ProcessBuilder = require('../app/assets/js/processbuilder')

// A 26.3-style manifest: java.library.path is the search folder; the other
// three are scratch folders libraries self-extract into, never searched.
const MODERN_JVM_ARGS = [
    '-Djava.library.path=${natives_directory}/java',
    '-Djna.tmpdir=${natives_directory}/jna',
    '-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}/lwjgl',
    '-Dio.netty.native.workdir=${natives_directory}/netty',
    { rules: [{ action: 'allow', os: { name: 'osx' } }], value: '-XstartOnFirstThread' }
]

function libraryDirFor(manifest, root){
    return ProcessBuilder.prototype._nativeLibraryDir.call({ vanillaManifest: manifest }, root)
}

test('26.x manifest: natives go to the folder -Djava.library.path names', () => {
    const root = path.join('tmp', 'WCNatives', 'deadbeef')
    assert.strictEqual(libraryDirFor({ arguments: { jvm: MODERN_JVM_ARGS } }, root), path.join(root, 'java'))
})

test('a rule-wrapped java.library.path argument is honored', () => {
    const root = path.join('tmp', 'WCNatives', 'deadbeef')
    const manifest = { arguments: { jvm: [{ rules: [], value: '-Djava.library.path=${natives_directory}/java' }] } }
    assert.strictEqual(libraryDirFor(manifest, root), path.join(root, 'java'))
})

test('pre-26 manifest with a bare natives_directory stays flat', () => {
    const root = path.join('tmp', 'WCNatives', 'deadbeef')
    assert.strictEqual(libraryDirFor({ arguments: { jvm: ['-Djava.library.path=${natives_directory}'] } }, root), root)
})

test('manifest without jvm arguments stays flat', () => {
    const root = path.join('tmp', 'WCNatives', 'deadbeef')
    assert.strictEqual(libraryDirFor({}, root), root)
})

test('natives are extracted synchronously into the java.library.path folder', { timeout: 20000 }, async (t) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imperium-natives-'))
    t.after(() => fs.remove(workDir))
    const root = path.join(workDir, 'natives')
    const libPath = path.join(workDir, 'libraries')

    // Build two fake natives jars: an lwjgl one and a netty one. The
    // classifier carries process.arch so the 1.19+ arch filter lets it
    // through on any machine running the test.
    const lwjglJarPath = path.join(libPath, 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar')
    const lwjglZip = new AdmZip()
    lwjglZip.addFile('lwjgl.dll', Buffer.from('fake lwjgl.dll bytes'))
    lwjglZip.addFile('META-INF/MANIFEST.MF', Buffer.from('excluded'))
    await fs.ensureDir(path.dirname(lwjglJarPath))
    lwjglZip.writeZip(lwjglJarPath)

    const nettyJarPath = path.join(libPath, 'io/netty/netty-transport-native-windows/4.1.100.Final/netty-transport-native-windows-4.1.100.Final.jar')
    const nettyZip = new AdmZip()
    nettyZip.addFile('io/netty/netty_native.dll', Buffer.from('fake netty bytes'))
    await fs.ensureDir(path.dirname(nettyJarPath))
    nettyZip.writeZip(nettyJarPath)

    const manifest = {
        arguments: { jvm: MODERN_JVM_ARGS },
        libraries: [
            {
                name: `org.lwjgl:lwjgl:3.3.3:natives-windows-${process.arch}`,
                downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar' } }
            },
            {
                name: `io.netty:netty-transport-native-windows:4.1.100.Final:natives-windows-${process.arch}`,
                downloads: { artifact: { path: 'io/netty/netty-transport-native-windows/4.1.100.Final/netty-transport-native-windows-4.1.100.Final.jar' } }
            },
            {
                name: 'com.google.guava:guava:31.1-jre',
                downloads: { artifact: { path: 'com/google/guava/guava/31.1-jre/guava-31.1-jre.jar' } }
            }
        ]
    }

    const libs = ProcessBuilder.prototype._resolveMojangLibraries.call(
        Object.assign(Object.create(ProcessBuilder.prototype), { vanillaManifest: manifest, libPath }), root)

    // Every native, lwjgl and netty alike, must sit in the folder the JVM
    // searches (issue #4: 0.1.4-0.2.4 put lwjgl.dll in lwjgl/ and crashed).
    assert.strictEqual(fs.existsSync(path.join(root, 'java', 'lwjgl.dll')), true, 'lwjgl.dll not in java.library.path')
    assert.strictEqual(fs.existsSync(path.join(root, 'java', 'netty_native.dll')), true, 'netty dll not in java.library.path')
    assert.strictEqual(fs.existsSync(path.join(root, 'lwjgl', 'lwjgl.dll')), false, 'lwjgl.dll went to the SharedLibraryExtractPath scratch folder')
    assert.strictEqual(fs.existsSync(path.join(root, 'lwjgl.dll')), false, 'lwjgl.dll was flattened into the natives root')
    // META-INF exclusion is honored.
    assert.strictEqual(fs.existsSync(path.join(root, 'java', 'META-INF')), false)
    // Plain libraries still resolve onto the classpath map.
    assert.strictEqual(libs['com.google.guava:guava'], path.join(libPath, 'com/google/guava/guava/31.1-jre/guava-31.1-jre.jar'))
})

test('pre-1.19 natives-object branch extracts synchronously into the flat root', { timeout: 20000 }, async (t) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imperium-natives-legacy-'))
    t.after(() => fs.remove(workDir))
    const root = path.join(workDir, 'natives')
    const libPath = path.join(workDir, 'libraries')

    const jarPath = path.join(libPath, 'org/lwjgl/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-windows.jar')
    const zip = new AdmZip()
    zip.addFile('lwjgl.dll', Buffer.from('legacy fake lwjgl.dll bytes'))
    await fs.ensureDir(path.dirname(jarPath))
    zip.writeZip(jarPath)

    const manifest = {
        // No arguments block at all: everything must fall back to the root.
        libraries: [
            {
                name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4',
                natives: { windows: 'natives-windows' },
                downloads: { classifiers: { 'natives-windows': { path: 'org/lwjgl/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-windows.jar' } } }
            }
        ]
    }

    ProcessBuilder.prototype._resolveMojangLibraries.call(
        Object.assign(Object.create(ProcessBuilder.prototype), { vanillaManifest: manifest, libPath }), root)

    assert.strictEqual(fs.existsSync(path.join(root, 'lwjgl.dll')), true, 'legacy natives not extracted to the flat root')
})
