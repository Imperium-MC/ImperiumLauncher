#!/usr/bin/env node
/**
 * Romanica distribution index generator (milestone 2).
 *
 * Builds distribution/distribution.json with REAL artifacts: sizes, MD5s
 * (validation baseline), SHA-256s (stronger post-download verification) and URLs
 * for everything the launcher must sync — Fabric loader + its profile libraries
 * (MD5s straight from meta.fabricmc.net), Imperium Client (from a local jar or a
 * published GitHub release), Fabric API, and the performance-pack mods (resolved
 * against the Modrinth API for MC 26.3; jars are downloaded once and hashed, then
 * cached in .distro-cache so re-runs are instant).
 *
 * Usage:
 *   node scripts/generate-distro.cjs                    # full generate
 *   node scripts/generate-distro.cjs --client <jar>     # hash a local client jar
 *                                                      # and point its URL at the
 *                                                      # future GitHub release
 *
 * The Minecraft client itself, its libraries and assets come from Mojang via
 * minecraftVersion — they are NOT listed here (Helios handles that).
 *
 * Re-run and commit whenever the pack changes, then verify every artifact URL
 * serves what the checklist in docs/distribution-index.md requires.
 *
 * ROMANICA CUTOVER: regenerating with the Romanica server id RESETS every
 * player's instance folder (the launcher keys instances and settings by
 * server id). Commit the regenerated distribution.json only at cutover,
 * together with the smoke.yml SERVER_ID flip.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MC_VERSION = '26.3';
const SERVER_ID = 'Romanica';
const UA = { 'User-Agent': 'RomanicaLauncher-distgen/1.0 (romanica.net)' };

// The performance pack (Fabulously-Optimized-based). Modrinth slugs.
// `required: { value: false, def: true }` lets players disable it in the Mods tab.
const PERFORMANCE_MODS = [
  'sodium',
  'lithium',
  'ferrite-core',
  'immediatelyfast',
  'entityculling',
  'modernfix',
  'dynamic-fps',
  'lazydfu',
];

const CACHE_DIR = path.join(__dirname, '..', '.distro-cache');
const OUT = path.join(__dirname, '..', 'distribution', 'distribution.json');

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/** Download once, cache forever (content-addressed by URL hash). Returns { size, md5, sha256 }. */
async function hashArtifact(url) {
  const key = crypto.createHash('md5').update(url).digest('hex');
  const metaPath = path.join(CACHE_DIR, `${key}.json`);
  const cached = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;
  if (cached && cached.sha256) return cached;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const meta = {
    size: buf.length,
    md5: crypto.createHash('md5').update(buf).digest('hex'),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  return meta;
}

/**
 * Build a distribution artifact entry. MD5 stays the validation baseline for
 * helios-core's DistributionIndexProcessor; sha256 is emitted alongside it
 * whenever we hashed the file locally, so the launcher's post-download
 * verification can prefer the stronger hash.
 */
function artifact(url, hash, size, sha256) {
  return { size, MD5: hash, ...(sha256 ? { sha256 } : {}), url };
}

async function fabricModules() {
  // Latest loader for this MC version (prefer stable when present).
  const loaders = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${MC_VERSION}`);
  const best = loaders.find((l) => l.loader.stable) || loaders[0];
  const loaderVersion = best.loader.version;
  const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${MC_VERSION}/${loaderVersion}/profile/json`;
  const profile = await fetchJson(profileUrl);
  const profileBuf = await (await fetch(profileUrl, { headers: UA })).arrayBuffer();

  const subModules = [
    {
      id: `fabric-loader-${loaderVersion}-${MC_VERSION}`,
      name: 'Fabric Version Manifest',
      type: 'VersionManifest',
      artifact: artifact(
        profileUrl,
        crypto.createHash('md5').update(Buffer.from(profileBuf)).digest('hex'),
        profileBuf.byteLength,
        crypto.createHash('sha256').update(Buffer.from(profileBuf)).digest('hex')
      ),
    },
    // Every library from the profile with hash metadata. The profile's library list
    // also repeats the loader itself as a url-only entry — skip those; the loader
    // jar is the top-level module artifact (hashed separately above).
    ...profile.libraries.filter((lib) => lib.size && lib.md5).map((lib) => ({
      id: lib.name,
      name: lib.name.split(':').slice(0, 2).join(':'),
      type: 'Library',
      artifact: {
        size: lib.size,
        MD5: lib.md5,
        url: mavenUrl(lib.url, lib.name),
      },
    })),
  ];

  // The loader jar itself.
  const loaderJarUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${loaderVersion}/fabric-loader-${loaderVersion}.jar`;
  const loaderJar = await hashArtifact(loaderJarUrl);

  return {
    fabric: {
      id: `net.fabricmc:fabric-loader:${loaderVersion}`,
      name: 'Fabric Loader',
      type: 'Fabric',
      required: { value: true, def: true },
      artifact: artifact(loaderJarUrl, loaderJar.md5, loaderJar.size, loaderJar.sha256),
      subModules,
    },
    loaderVersion,
  };
}

/** Maven coordinate group:artifact:version -> absolute jar URL on the given repo base. */
function mavenUrl(repoBase, coord) {
  const [group, art, version] = coord.split('@')[0].split(':');
  const ext = coord.includes('@') ? coord.split('@')[1] : 'jar';
  const base = repoBase.endsWith('/') ? repoBase : repoBase + '/';
  return `${base}${group.replace(/\./g, '/')}/${art}/${version}/${art}-${version}.${ext}`;
}

async function modrinthModule(slug) {
  const versions = await fetchJson(
    `https://api.modrinth.com/v2/project/${slug}/version?game_versions=${encodeURIComponent(
      JSON.stringify([MC_VERSION])
    )}&loaders=${encodeURIComponent(JSON.stringify(['fabric']))}`
  );
  if (!versions.length) throw new Error(`no ${MC_VERSION} fabric build for ${slug} on Modrinth`);
  const version = versions[0];
  const file = version.files.find((f) => f.primary) || version.files[0];
  const hashed = await hashArtifact(file.url);
  return {
    id: `com.modrinth.${slug}:${version.version_number}`,
    name: version.name || slug,
    type: 'FabricMod',
    required: { value: false, def: true },
    artifact: artifact(file.url, hashed.md5, hashed.size, hashed.sha256),
  };
}

async function latestClientVersion() {
  const res = await fetch('https://api.github.com/repos/Romanica-MC/ImperiumClient/releases/latest', { headers: UA });
  if (!res.ok) throw new Error('cannot resolve latest Imperium Client release');
  const tag = (await res.json()).tag_name || '';
  if (!tag.startsWith('v')) throw new Error(`unexpected latest tag ${tag}`);
  return tag.slice(1);
}

async function imperiumClientModule(localJarPath, versionOverride) {
  // ROMANICA CUTOVER: the client module id/name/release URL follow the
  // ImperiumClient repository and stay Imperium-branded until that repo
  // renames in the org-rename phase.
  // The client release version is independent of the launcher's own version:
  // --client-version pins it explicitly; otherwise the latest published
  // release resolves. --client hashes a locally built jar so the index is
  // ready the moment that exact jar is uploaded.
  const VERSION = versionOverride || (await latestClientVersion());
  // v0.2.0-beta.10+ renamed the release asset to RomanicaClient; older tags shipped
  // ImperiumClient. Resolve whichever exists (HEAD probe, HEAD may lie about size but
  // 200-vs-404 is reliable).
  const romanicaUrl = `https://github.com/Romanica-MC/ImperiumClient/releases/download/v${VERSION}/RomanicaClient-${VERSION}%2B${MC_VERSION}.jar`;
  const legacyUrl = `https://github.com/Romanica-MC/ImperiumClient/releases/download/v${VERSION}/ImperiumClient-${VERSION}%2B${MC_VERSION}.jar`;
  const headOk = await fetch(romanicaUrl, { method: 'HEAD', headers: UA }).then(r => r.ok).catch(() => false);
  const releaseUrl = headOk ? romanicaUrl : legacyUrl;
  let hash, size, sha256;
  if (localJarPath) {
    const buf = fs.readFileSync(localJarPath);
    hash = crypto.createHash('md5').update(buf).digest('hex');
    sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    size = buf.length;
    console.log(`  client: hashed local jar ${path.basename(localJarPath)} (${size} bytes)`);
  } else {
    const cached = await hashArtifact(releaseUrl).catch(() => null);
    if (!cached) {
      throw new Error(
        `Imperium Client release not published yet (${releaseUrl}) — build one and pass --client <jar>`
      );
    }
    hash = cached.md5;
    sha256 = cached.sha256;
    size = cached.size;
  }
  return {
    id: `net.imperiummc:imperium-client:${VERSION}`,
    name: 'Imperium Client',
    type: 'FabricMod',
    artifact: artifact(releaseUrl, hash, size, sha256),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const clientJarIdx = args.indexOf('--client');
  const clientJar = clientJarIdx >= 0 ? args[clientJarIdx + 1] : null;
  const clientVersionIdx = args.indexOf('--client-version');
  const clientVersion = clientVersionIdx >= 0 ? args[clientVersionIdx + 1] : null;

  console.log('Resolving Fabric for MC', MC_VERSION, '...');
  const { fabric, loaderVersion } = await fabricModules();
  console.log(`  loader ${loaderVersion}, ${fabric.subModules.length} submodules (manifest + libraries)`);

  console.log('Resolving Imperium Client ...');
  const client = await imperiumClientModule(clientJar, clientVersion);

  console.log('Resolving Fabric Language Kotlin ...');
  const flk = await modrinthModule('fabric-language-kotlin');
  flk.required = { value: true, def: true }; // Imperium Client is written in Kotlin
  flk.id = flk.id.replace('%2B', '+');

  console.log('Resolving Fabric API ...');
  const fabricApi = await modrinthModule('fabric-api');
  fabricApi.required = { value: true, def: true }; // Imperium Client depends on it
  fabricApi.id = fabricApi.id.replace('%2B', '+'); // Maven ids carry the raw version

  console.log('Resolving performance pack ...');
  const perf = [];
  for (const slug of PERFORMANCE_MODS) {
    try {
      perf.push(await modrinthModule(slug));
      console.log(`  ${slug} ok`);
    } catch (e) {
      console.log(`  ${slug} SKIPPED: ${e.message}`);
    }
  }

  const index = {
    version: '1.0.0',
    rss: 'https://romanica.net/news.rss',
    discord: {
      clientId: 'REPLACE_WITH_BOT_CLIENT_ID',
      smallImageText: 'Romanica',
      smallImageKey: 'seal',
    },
    servers: [
      {
        id: SERVER_ID,
        name: 'Romanica',
        description: 'Story-driven Roman prison server.',
        // ROMANICA CUTOVER: icon flips with the GitHub org rename.
        icon: 'https://raw.githubusercontent.com/Romanica-MC/RomanicaLauncher/master/app/assets/images/SealCircle.png',
        version: require('../package.json').version,
        // CUTOVER 2026-10-22: play.romanica.net answers MC status (verified live);
        // play.imperiummc.net keeps answering - both addresses connect.
        address: 'play.romanica.net',
        minecraftVersion: MC_VERSION,
        mainServer: true,
        autoconnect: true,
        javaOptions: {
          supported: '>=25',
          suggestedMajor: 25,
          ram: { recommended: 4096, minimum: 2048 },
        },
        modules: [fabric, client, flk, fabricApi, ...perf],
      },
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(index, null, 4) + '\n');
  const modules = index.servers[0].modules.length;
  console.log(`\nWrote ${OUT} (${modules} top-level modules, ${fabric.subModules.length} loader submodules).`);
  console.log('Next: verify every artifact URL serves its size+MD5+sha256 (docs checklist),');
  console.log('fill the discord clientId (or drop the discord block), then bump REMOTE_DISTRO_URL.');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
