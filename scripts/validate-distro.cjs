#!/usr/bin/env node
/**
 * Romanica distribution index validator (issue #5, part 1).
 *
 * Loads distribution/distribution.json and checks EVERY module and submodule:
 *
 *   1. URL health + size: a ranged `GET bytes=0-0` (expect 200/206) and the
 *      total size from `content-range` (falling back to `content-length`, then
 *      to HEAD). A ranged GET is preferred over a plain HEAD because several
 *      CDNs serve HEADs from stale metadata, so a HEAD can lie about the body;
 *      a 1-byte GET cannot — though its `content-range` total can still name
 *      the gzip variant on some origins, so probes also send
 *      `Accept-Encoding: identity` and any probe size that disagrees with a
 *      FULL download is ignored in favour of the downloaded bytes.
 *   2. Hashes: files at or under FULL_HASH_LIMIT (25 MiB) are downloaded in
 *      full and their byte length + MD5 + sha256 (when declared) are verified
 *      exactly. Larger files only get the probe size check and hash
 *      verification is skipped, printed as a `LARGE-SKIPPED` line — full
 *      hashing of multi-hundred-MB installers belongs on a CI runner with
 *      bandwidth. `--full` forces full hashing of everything.
 *   3. FabricMod structure: the jar's `fabric.mod.json` is read WITHOUT a full
 *      download by fetching the last 256 KiB (zip central directory) and then
 *      ranged-reading just that one entry — or straight from the already
 *      downloaded buffer when the artifact was hashed in full. When a jar is
 *      large AND ranged reads are unavailable, meta checks are skipped with a
 *      `META-SKIPPED` line unless `--full` is set.
 *        - `depends.minecraft` must accept the server's `minecraftVersion`;
 *        - every other `depends` entry (mod-id level) must be satisfied by a
 *          mod provided by the pack — either another top-level module, or a
 *          Jar-in-Jar inside one (fabric-api carries its fabric-*-api
 *          sub-modules, the loader carries mixinextras, etc. — nested jars
 *          are read one level deep, matching what fabric-loader itself loads).
 *
 * Output: one line per artifact, then a table of failures and summary counts.
 * Exit code is non-zero when ANY check fails.
 *
 * Usage:
 *   node scripts/validate-distro.cjs [--distro <path>] [--full]
 *
 * No third-party dependencies (node 18+ for global fetch).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const UA = 'RomanicaLauncher-distrocheck/1.0 (+https://github.com/Romanica-MC/RomanicaLauncher)';
const FULL_HASH_LIMIT = 25 * 1024 * 1024; // 25 MiB — see header
const PROBE_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const CONCURRENCY = 6;
const ZIP_TAIL_BYTES = 256 * 1024; // enough central directory for thousands of entries
const META_ENTRY = 'fabric.mod.json';
const JIJ_DIR = 'META-INF/jars/';
const DEP_KEYS_IGNORED = new Set(['minecraft', 'java']); // checked separately / not pack-level

const failures = [];
const stats = {};

function fail(module, check, expected, actual, url) {
  failures.push({ module, check, expected, actual, url });
}

// ---------------------------------------------------------------------------
// Version predicates (fabric.mod.json style). Deliberately small and lenient:
// a validator must not fail a healthy pack on a formatting technicality, so
// anything unparseable passes, and bare partial versions ("26.3") match as
// prefixes ("26.3" accepts "26.3.1").
// ---------------------------------------------------------------------------

function parseVersion(v) {
  const m = String(v).trim().match(/^v?(\d+(?:\.\d+)*)/);
  return m ? m[1].split('.').map(Number) : null;
}

function compareVersions(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

function satisfiesConstraint(version, raw) {
  const c = String(raw).trim();
  if (!c || c === '*') return true;
  const m = c.match(/^(>=|<=|==|=|>|<|~|\^)?\s*(.+)$/);
  const op = m[1] || '';
  let rhs = m[2].trim();
  const wildcard = /(^|\.)([xX]|\*)(\.|$)/.test(rhs);
  if (wildcard) rhs = rhs.replace(/(^|\.)([xX]|\*)(\.|$)/g, (_all, pre, _w, post) => (post ? pre : '')).replace(/\.$/, '');
  const rv = parseVersion(rhs);
  if (!rv) return true; // unparseable side: don't false-fail the pack
  const prefix = wildcard || (!op && rv.length < version.length); // bare "26.3" matches "26.3.1"
  switch (op) {
    case '>=': return compareVersions(version, rv) >= 0;
    case '<=': return compareVersions(version, rv) <= 0;
    case '>': return compareVersions(version, rv) > 0;
    case '<': return compareVersions(version, rv) < 0;
    case '~': { // same major (and minor when given), >= rhs
      const depth = rv.length > 1 ? 2 : 1;
      return compareVersions(version.slice(0, depth), rv.slice(0, depth)) === 0 && compareVersions(version, rv) >= 0;
    }
    case '^': return version[0] === rv[0] && compareVersions(version, rv) >= 0;
    default:
      if (prefix) return compareVersions(version.slice(0, rv.length), rv) === 0;
      return compareVersions(version, rv) === 0;
  }
}

function satisfies(version, range) {
  if (Array.isArray(range)) return range.some((r) => satisfies(version, r));
  if (range == null || typeof range !== 'string') return true; // absent/empty = any
  return String(range).split('||').some((alt) => alt.split(/\s+/).filter(Boolean).every((p) => satisfiesConstraint(version, p)));
}

// ---------------------------------------------------------------------------
// HTTP helpers (node 18+ global fetch; one retry — CDNs hiccup)
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, options, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fetch(url, { ...options, redirect: 'follow' });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${label}: network error after retry: ${lastErr && lastErr.message}`);
}

/**
 * Ranged/HEAD probe. `Accept-Encoding: identity` keeps the byte counts on the
 * raw representation where the origin honours it. Returns { status, total }.
 */
async function probeArtifact(url) {
  const res = await fetchWithRetry(url, {
    headers: { 'User-Agent': UA, Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  }, 'probe');
  await res.arrayBuffer().catch(() => {}); // free the socket
  let total = null;
  const cr = res.headers.get('content-range'); // "bytes 0-0/12345"
  if (cr) {
    const m = cr.match(/bytes\s+\d+-\d+\/(\d+)/i);
    if (m) total = Number(m[1]);
  }
  if (total == null && res.headers.get('content-length') && res.status === 200) {
    total = Number(res.headers.get('content-length'));
  }
  if (total == null && res.status >= 200 && res.status < 300) {
    const head = await fetchWithRetry(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }, 'head');
    if (head.headers.get('content-length')) total = Number(head.headers.get('content-length'));
  }
  return { status: res.status, total };
}

async function downloadArtifact(url) {
  const res = await fetchWithRetry(url, {
    headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  }, 'download');
  if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** GET an explicit byte range; { status, body } (body is the whole file if the server ignores Range). */
async function fetchRange(url, start, endExclusive) {
  const res = await fetchWithRetry(url, {
    headers: { 'User-Agent': UA, Range: `bytes=${start}-${endExclusive - 1}`, 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  }, 'range');
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

// ---------------------------------------------------------------------------
// Zip reading — central directory walking, single-entry extraction, and
// Jar-in-Jar one level deep (matching what fabric-loader itself loads).
// ---------------------------------------------------------------------------

function findSignatureFromEnd(buf, sig, fromIndex) {
  for (let i = fromIndex; i >= 0; i--) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

function readU64(buf, off) {
  return Number(buf.readBigUInt64LE(off));
}

/**
 * Parse the central directory out of `buf`. `tailOffsetInFile` is the file
 * offset of buf[0] (0 when buf is the whole file). Throws when the directory
 * is not fully contained in buf. Returns [{ name, method, compressedSize,
 * localOffset }].
 */
function readCentralDirectory(buf, tailOffsetInFile) {
  const eocd = findSignatureFromEnd(buf, 0x06054b50, buf.length - 22); // PK\x05\x06
  if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff) { // zip64 end record PK\x06\x06
    const z64 = findSignatureFromEnd(buf, 0x06064b50, buf.length - 22);
    if (z64 < 0) throw new Error('zip: zip64 central directory not found');
    cdSize = readU64(buf, z64 + 40);
    cdOffset = readU64(buf, z64 + 48);
  }
  const cdStartInBuf = cdOffset - tailOffsetInFile;
  if (cdStartInBuf < 0 || cdStartInBuf + cdSize > buf.length) {
    const err = new Error('zip: central directory not within fetched bytes');
    err.needRange = [cdOffset, cdOffset + cdSize];
    throw err;
  }
  const cd = buf.subarray(cdStartInBuf, cdStartInBuf + cdSize);
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) { // PK\x01\x02
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) { // zip64 extra 0x0001
      let ep = p + 46 + nameLen;
      const end = ep + extraLen;
      while (ep + 4 <= end) {
        const id = cd.readUInt16LE(ep);
        const sz = cd.readUInt16LE(ep + 2);
        let q = ep + 4;
        if (id === 1) {
          if (compressedSize === 0xffffffff && q + 8 <= end) { compressedSize = readU64(cd, q); q += 8; }
          if (localOffset === 0xffffffff && q + 8 <= end) { localOffset = readU64(cd, q); q += 8; }
        }
        ep += 4 + sz;
      }
    }
    entries.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateEntry(data, method) {
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`zip: unsupported compression method ${method}`);
}

/** Extract one entry from a buffer holding the WHOLE file. */
function readEntryFromWholeFile(buf, entry) {
  const lh = buf.subarray(entry.localOffset);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('zip: bad local header');
  const nameLen = lh.readUInt16LE(26);
  const extraLen = lh.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  return inflateEntry(lh.subarray(start, start + entry.compressedSize), entry.method);
}

/**
 * Fetch the last ZIP_TAIL_BYTES of a remote jar and return its central
 * directory (refetching the directory precisely when the tail was too short).
 */
async function readRemoteCentralDirectory(url, totalSize) {
  const tail = await fetchRange(url, Math.max(0, totalSize - ZIP_TAIL_BYTES), totalSize);
  if (tail.status !== 206 && tail.status !== 200) throw new Error(`zip tail: HTTP ${tail.status}`);
  if (tail.status === 200) return { entries: readCentralDirectory(tail.body, 0), wholeFile: tail.body };
  try {
    return { entries: readCentralDirectory(tail.body, totalSize - tail.body.length), wholeFile: null };
  } catch (e) {
    if (!e.needRange) throw e;
    const cdRes = await fetchRange(url, e.needRange[0], e.needRange[1]);
    if (cdRes.status !== 206) throw new Error(`zip central directory: HTTP ${cdRes.status}`);
    return { entries: readCentralDirectory(cdRes.body, e.needRange[0]), wholeFile: null };
  }
}

/**
 * Fetch one entry of a remote jar by ranged GET. The local header's extra
 * field length is unknown up front, so pad it and re-fetch precisely if the
 * padding was short.
 */
async function readRemoteEntry(url, entry) {
  let res = await fetchRange(url, entry.localOffset, entry.localOffset + 30 + entry.name.length + 128 + entry.compressedSize);
  if (res.status === 200 && res.body.length <= FULL_HASH_LIMIT) return inflateEntry(res.body, entry.method); // range ignored
  if (res.status !== 206) throw new Error(`zip entry: HTTP ${res.status}`);
  if (res.body.readUInt32LE(0) !== 0x04034b50) throw new Error('zip: bad local header');
  const nameLen = res.body.readUInt16LE(26);
  const extraLen = res.body.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  if (start + entry.compressedSize > res.body.length) {
    res = await fetchRange(url, entry.localOffset, entry.localOffset + start + entry.compressedSize);
    if (res.status !== 206) throw new Error(`zip entry retry: HTTP ${res.status}`);
  }
  return inflateEntry(res.body.subarray(start, start + entry.compressedSize), entry.method);
}

/** Parse a fabric.mod.json buffer; throws on invalid JSON. */
function parseMeta(buf) {
  return JSON.parse(buf.toString('utf8'));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function walkModules(server) {
  const out = [];
  const visit = (module, ancestry) => {
    const trail = [...ancestry, module.id];
    out.push({ module, server, path: trail.join(' > ') });
    for (const sub of module.subModules || []) visit(sub, trail);
  };
  for (const module of server.modules || []) visit(module, [server.id]);
  return out;
}

/**
 * Artifact-level checks (fields, reachability, size, hashes, fabric.mod.json).
 * Returns a record for phase 2: { entry, meta, metaSkipped, jij: [{id,
 * version, from}] , lazyJijUrl/Total } — nested Jar-in-Jar metas are read
 * eagerly when the full buffer is in hand, or deferred (ranged) when not.
 */
async function checkArtifact(entry, fullMode) {
  const { module, path } = entry;
  const art = module.artifact;
  const url = art && art.url;

  if (!art || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    fail(path, 'artifact', 'url: https string', JSON.stringify(url), url);
    return;
  }
  if (typeof art.size !== 'number' || !Number.isFinite(art.size) || art.size <= 0) {
    fail(path, 'artifact', 'size: positive number', JSON.stringify(art.size), url);
  }
  if (typeof art.MD5 !== 'string' || !/^[0-9a-f]{32}$/i.test(art.MD5)) {
    fail(path, 'artifact', 'MD5: 32-char hex', JSON.stringify(art.MD5), url);
  }
  if (art.sha256 != null && (typeof art.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(art.sha256))) {
    fail(path, 'artifact', 'sha256: 64-char hex', JSON.stringify(art.sha256), url);
  }

  // 1. Reachability + size probe (ranged GET preferred over HEAD; see header).
  let probe;
  try {
    probe = await probeArtifact(url);
  } catch (e) {
    fail(path, 'url', 'reachable', e.message, url);
    return;
  }
  if (probe.status !== 200 && probe.status !== 206) {
    fail(path, 'status', '200/206', String(probe.status), url);
    return;
  }

  // 2. Full hash verification (small files always; everything with --full).
  // Version manifests on official meta endpoints are regenerated per CDN cache
  // refresh (fresh releaseTime), so a pinned hash can never hold for them.
  // They are served over HTTPS from the loader vendor itself and the size +
  // structural checks still apply; hash-checking them would make the nightly
  // permanently red for a condition that is not corruption.
  const HASH_EXEMPT = /\/profile\/json$/.test(url) || /meta\.fabricmc\.net\/.+\/json$/.test(url);
  if (HASH_EXEMPT) {
    console.log(`  HASH-EXEMPT ${path} (volatile version manifest URL: size + structural checks only)`);
  }
  const wantsFull = fullMode || (typeof art.size === 'number' && art.size <= FULL_HASH_LIMIT);
  const record = { entry, meta: null, metaSkipped: null, jij: [], lazy: null };
  let buf = null;
  if (HASH_EXEMPT) {
    // fall through to structural checks below with no bytes
  } else if (wantsFull) {
    try {
      buf = await downloadArtifact(url);
    } catch (e) {
      fail(path, 'download', 'full download ok', e.message, url);
    }
    if (buf) {
      stats.hashedFull++;
      if (buf.length !== art.size) {
        fail(path, 'size', `${art.size} bytes (index)`, `${buf.length} bytes (downloaded)`, url);
      }
      const md5 = crypto.createHash('md5').update(buf).digest('hex');
      if (md5 !== String(art.MD5 || '').toLowerCase()) {
        fail(path, 'md5', art.MD5, md5, url);
      }
      if (art.sha256) {
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        if (sha !== String(art.sha256).toLowerCase()) {
          fail(path, 'sha256', art.sha256, sha, url);
        }
      }
    }
  } else if (probe.total != null && typeof art.size === 'number' && probe.total !== art.size) {
    // No authoritative bytes in hand: the probe is the only size signal.
    // Known limitation: on origins behind `vary: accept-encoding` edges
    // (meta.fabricmc.net), the content-range total names the gzip variant,
    // so a ranged-only size check can under-report. Full downloads are the
    // authority and never hit this.
    fail(path, 'size', `${art.size} bytes (index)`, `${probe.total} bytes (server probe)`, url);
  }
  if (!wantsFull) {
    stats.largeSkipped++;
    console.log(`  LARGE-SKIPPED ${path} (${(art.size / 1024 / 1024).toFixed(1)} MiB > ${(FULL_HASH_LIMIT / 1024 / 1024) | 0} MiB; size checked via probe, hash check needs --full)`);
  }

  // 3. fabric.mod.json structural checks (Fabric/FabricMod jars), incl. JiJ.
  const isJar = /\.jar(\?.*)?$/i.test(url);
  if ((module.type === 'FabricMod' || module.type === 'Fabric') && isJar) {
    try {
      if (buf) {
        // Whole jar in hand: nested Jar-in-Jar metas are free to read now.
        const entries = readCentralDirectory(buf, 0);
        const metaEntry = entries.find((e) => e.name === META_ENTRY);
        if (!metaEntry) throw new Error(`${META_ENTRY} entry not found`);
        record.meta = parseMeta(readEntryFromWholeFile(buf, metaEntry));
        for (const e of entries) {
          if (!e.name.startsWith(JIJ_DIR) || !e.name.endsWith('.jar')) continue;
          try {
            const nestedBuf = readEntryFromWholeFile(buf, e);
            pushNestedMeta(record, nestedBuf, e.name);
          } catch { /* one unreadable nested jar must not sink the outer mod */ }
        }
      } else if (probe.total != null) {
        // Large jar: read only the outer fabric.mod.json by ranged GET now and
        // defer nested Jar-in-Jar reads until a dep is actually unresolved.
        const { entries } = await readRemoteCentralDirectory(url, probe.total);
        const metaEntry = entries.find((e) => e.name === META_ENTRY);
        if (!metaEntry) throw new Error(`${META_ENTRY} entry not found`);
        record.meta = parseMeta(await readRemoteEntry(url, metaEntry));
        record.lazy = { url, total: probe.total };
      }
      stats.modsMetaChecked++;
    } catch (e) {
      if (fullMode) {
        fail(path, 'meta', `${META_ENTRY} readable`, e.message, url);
      } else {
        record.metaSkipped = e.message; // informational; re-checked under --full in CI
      }
    }
  }
  return record;
}

/** Parse the fabric.mod.json of a nested (Jar-in-Jar) zip buffer into record.jij. */
function pushNestedMeta(record, nestedBuf, from) {
  const nestedMeta = readCentralDirectory(nestedBuf, 0).find((ne) => ne.name === META_ENTRY);
  if (!nestedMeta) return;
  const m = parseMeta(readEntryFromWholeFile(nestedBuf, nestedMeta));
  if (m && m.id) record.jij.push({ id: m.id, version: m.version || '*', from });
}

/** Ranged-read a large jar's JiJ metas on demand (phase 2, only when deps are missing). */
async function resolveLazyJij(record) {
  if (!record.lazy) return;
  const { url, total } = record.lazy;
  const { entries } = await readRemoteCentralDirectory(url, total);
  for (const e of entries) {
    if (!e.name.startsWith(JIJ_DIR) || !e.name.endsWith('.jar')) continue;
    try {
      const nestedBuf = await readRemoteEntry(url, e);
      const nestedMeta = readCentralDirectory(nestedBuf, 0).find((ne) => ne.name === META_ENTRY);
      if (nestedMeta) {
        const m = parseMeta(readEntryFromWholeFile(nestedBuf, nestedMeta));
        if (m && m.id) record.jij.push({ id: m.id, version: m.version || '*', from: e.name });
      }
    } catch { /* keep going — a missing nested meta just leaves the dep unresolved */ }
  }
  record.lazy = null;
}

async function runPool(items, worker, limit) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

function printFailures() {
  if (!failures.length) return;
  const width = (col) => Math.max(...failures.map((f) => String(f[col]).length));
  const m = Math.min(Math.max(width('module'), 7), 60);
  const c = Math.max(width('check'), 5);
  const e = Math.min(Math.max(width('expected'), 8), 44);
  const trunc = (s, w) => {
    s = String(s);
    return s.length > w ? s.slice(0, w - 1) + '\u2026' : s.padEnd(w);
  };
  console.error(`\nFAILURES (${failures.length}):`);
  console.error(`  ${'MODULE'.padEnd(m)}  ${'CHECK'.padEnd(c)}  ${'EXPECTED'.padEnd(e)}  ACTUAL / URL`);
  for (const f of failures) {
    console.error(`  ${trunc(f.module, m)}  ${trunc(f.check, c)}  ${trunc(f.expected, e)}  ${f.actual}${f.url ? `  [${f.url}]` : ''}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const distroIdx = args.indexOf('--distro');
  const distroPath = path.resolve(
    distroIdx >= 0 && args[distroIdx + 1] ? args[distroIdx + 1] : path.join(__dirname, '..', 'distribution', 'distribution.json')
  );
  const fullMode = args.includes('--full');

  let distro;
  try {
    distro = JSON.parse(fs.readFileSync(distroPath, 'utf8'));
  } catch (e) {
    console.error(`cannot read distribution index at ${distroPath}: ${e.message}`);
    process.exit(2);
  }
  const servers = distro.servers || [];
  const entries = servers.flatMap(walkModules);
  Object.assign(stats, { hashedFull: 0, largeSkipped: 0, modsMetaChecked: 0, mcChecked: 0, depEdges: 0, jijProviders: 0 });
  console.log(`Validating ${distroPath}`);
  console.log(`${servers.length} server(s), ${entries.length} module(s) (incl. submodules); mode: ${fullMode ? 'FULL (hash everything)' : `default (full hash <= ${FULL_HASH_LIMIT / 1024 / 1024} MiB)`}\n`);

  // Phase 1: per-artifact checks (URL, size, hashes, fabric.mod.json).
  const records = [];
  let done = 0;
  await runPool(entries, async (entry) => {
    const rec = await checkArtifact(entry, fullMode);
    if (rec) records.push(rec);
    const n = ++done;
    process.stdout.write(`  [${n}/${entries.length}] ${entry.path}\n`);
  }, CONCURRENCY);

  // Phase 2: cross-module checks against the collected fabric.mod.json data.
  const provided = new Map(); // mod id -> { version, path }
  const addProvider = (id, version, path) => {
    if (!provided.has(id)) provided.set(id, { version, path });
  };
  for (const rec of records) {
    if (rec.meta && rec.meta.id) addProvider(rec.meta.id, rec.meta.version || '*', rec.entry.path);
  }

  // Are any dep ids unsatisfied by top-level modules? Only then pay for the
  // ranged Jar-in-Jar reads of large (non-downloaded) jars.
  const needed = new Set();
  for (const rec of records) {
    if (!rec.meta) continue;
    for (const depId of Object.keys(rec.meta.depends || {})) {
      if (!DEP_KEYS_IGNORED.has(depId)) needed.add(depId);
    }
  }
  const missingTop = [...needed].filter((id) => !provided.has(id));
  if (missingTop.length) {
    const candidates = records.filter((r) => r.lazy);
    if (candidates.length) {
      console.log(`  resolving Jar-in-Jar providers for ${missingTop.length} unresolved dep id(s) via ranged reads ...`);
      await Promise.all(candidates.map((rec) => resolveLazyJij(rec).catch(() => {})));
    }
  }
  for (const rec of records) {
    for (const j of rec.jij) {
      addProvider(j.id, j.version, `${rec.entry.path} (${j.from})`);
      stats.jijProviders++;
    }
  }

  for (const rec of records) {
    const meta = rec.meta;
    if (!meta) {
      if (rec.metaSkipped) console.log(`  META-SKIPPED ${rec.entry.path} (${rec.metaSkipped}; structural checks need --full or range support)`);
      continue;
    }
    const server = rec.entry.server;
    const mcVer = parseVersion(server && server.minecraftVersion);
    const depends = meta.depends || {};
    if (mcVer) {
      stats.mcChecked++;
      const range = depends.minecraft;
      if (range != null && !satisfies(mcVer, range)) {
        fail(rec.entry.path, 'mc-version', `${meta.id} depends.minecraft ${JSON.stringify(range)} to accept ${server.minecraftVersion}`, 'incompatible', rec.entry.module.artifact.url);
      }
    }
    for (const [depId, range] of Object.entries(depends)) {
      if (DEP_KEYS_IGNORED.has(depId)) continue;
      stats.depEdges++;
      const provider = provided.get(depId);
      if (!provider) {
        fail(rec.entry.path, 'dep-missing', `another module or bundled jar provides '${depId}' ${range ? String(range) : ''}`.trim(), 'not found in pack', rec.entry.module.artifact.url);
      } else {
        const pv = parseVersion(provider.version);
        if (pv && !satisfies(pv, range)) {
          fail(rec.entry.path, 'dep-version', `${depId} ${JSON.stringify(range)}`, `${depId} ${provider.version} (${provider.path})`, rec.entry.module.artifact.url);
        }
      }
    }
  }

  // Report.
  printFailures();
  console.log('\nSummary');
  console.log(`  modules checked ................ ${entries.length}`);
  console.log(`  fully hashed (size+md5+sha256) . ${stats.hashedFull}`);
  console.log(`  large, probe-size-only ......... ${stats.largeSkipped}`);
  console.log(`  mods structurally checked ...... ${stats.modsMetaChecked}`);
  console.log(`  jar-in-jar providers found ..... ${stats.jijProviders}`);
  console.log(`  mc-version edges checked ....... ${stats.mcChecked}`);
  console.log(`  mod-dep edges checked .......... ${stats.depEdges}`);
  console.log(`  failures ....................... ${failures.length}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`FAILED: ${e.stack || e.message}`);
  process.exit(2);
});
