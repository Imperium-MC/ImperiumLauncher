# Romanica distribution index

The launcher downloads one JSON file, the *distribution index*, on every start. It lists the Minecraft version, the mod loader and every file to sync, so each player runs the server's exact pack. The launcher validates each file by size and MD5 before launch and re-downloads anything that's missing or wrong.

The format is Helios' own. [distro.md](distro.md) documents every field, and [helios-distribution-types](https://github.com/dscalzi/helios-distribution-types) is the source of truth. This page covers what Romanica's index must contain.

## Where it lives

| | |
| - | - |
| Launcher setting | `REMOTE_DISTRO_URL` in [`app/assets/js/distromanager.js`](../app/assets/js/distromanager.js) |
| Now (placeholder) | `https://raw.githubusercontent.com/Imperium-MC/ImperiumLauncher/master/distribution/distribution.json` |
| Planned | A Romanica-hosted URL such as `https://launcher.romanica.net/distribution.json` (Cloudflare R2 or Pages), set in milestone 2. ROMANICA CUTOVER: depends on romanica.net DNS |

> **DISTRO HOSTING — THREE STATES (verified 2026-10-24):**
> 1. **Released installers (v0.2.2–v0.2.6):** poll `raw.githubusercontent.com/Imperium-MC/ImperiumLauncher/master/...` (old org name — works via GitHub rename redirect; do NOT re-create that repo name).
> 2. **origin/master @ `5a34db0`+ (unreleased until v0.2.7):** flipped to `Romanica-MC/RomanicaLauncher`.
> 3. **v0.2.7 (`1ee2116`):** released Oct 24 with the Romanica-MC URL, Electron 44, client beta.25.
> Keep this table current whenever `distromanager.js` changes.

The placeholder has the server entry but no modules, so the launcher loads and reaches the login screen. Pressing Play fails with `No mod loader found!`.

If the index can't be downloaded, the launcher falls back to its last cached copy in `%APPDATA%\Romanica Launcher\distribution.json` (the userData directory). With no cache either, it can't start. Keep the URL stable, and always serve valid JSON from it.

## Required contents

### Index root

```json
{
    "version": "1.0.0",
    "rss": "https://imperiummc.net/news.rss",
    "discord": { "clientId": "...", "smallImageText": "Romanica", "smallImageKey": "seal" },
    "servers": [ { "...": "the server object below" } ]
}
```

`rss` and `discord` are optional. Without `rss` the news panel stays empty, and without `discord` Rich Presence is off.

### Server object

| Field | Value |
| ----- | ----- |
| `id` | `Romanica` (the generator's `SERVER_ID`; the deployed index still serves `ImperiumMC` until cutover). **Never change it after cutover.** The launcher keys instance folders and settings by this ID, and changing it orphans every player's installed instance (`instances/ImperiumMC` is left behind and the pack re-downloads to `instances/Romanica`). |
| `name` / `description` / `icon` | Shown on the landing page. |
| `version` | Bump on every pack change (semver). |
| `address` | `play.imperium-mc.net`. ROMANICA CUTOVER: address -> romanica.net (or play.romanica.net) when DNS is live |
| `minecraftVersion` | `26.3` |
| `mainServer` | `true` |
| `autoconnect` | `true` (joins the server on launch via Quick Play) |
| `javaOptions` | `{ "supported": ">=25", "suggestedMajor": 25, "ram": { "recommended": 4096, "minimum": 2048 } }`. MC 26.x needs Java 25. Without this, Helios guesses the Java version from the game version and picks the wrong one. |
| `modules` | The five groups below. |

### Modules

Every module with a download needs an `artifact` with `size` (bytes), `MD5` and `url`. All IDs except those of `File` modules are Maven coordinates (`group:artifact:version[@ext]`), which also decide where the file is stored.

#### 1. Fabric loader (`type: "Fabric"`)

```json
{
    "id": "net.fabricmc:fabric-loader:<loader-version>",
    "name": "Fabric Loader",
    "type": "Fabric",
    "artifact": { "size": 0, "MD5": "...", "url": "https://maven.fabricmc.net/net/fabricmc/fabric-loader/<v>/fabric-loader-<v>.jar" },
    "subModules": [
        {
            "id": "fabric-loader-<loader-version>-26.3",
            "name": "Fabric Version Manifest",
            "type": "VersionManifest",
            "artifact": { "size": 0, "MD5": "...", "url": "https://meta.fabricmc.net/v2/versions/loader/26.3/<loader-version>/profile/json" }
        },
        { "id": "<every library in that profile JSON>", "type": "Library", "artifact": { "...": "..." } }
    ]
}
```

- Exactly one mod-loader module per server. The launcher reads `mainClass` and arguments from the `VersionManifest` submodule.
- Every library listed in the Fabric profile JSON must also appear as a `Library` submodule (or a top-level `Library` module), with its own size and MD5.

#### 2. Imperium Client (`type: "FabricMod"`)

```json
{
    "id": "net.imperiummc:imperium-client:<version>",
    "name": "Imperium Client",
    "type": "FabricMod",
    "artifact": { "size": 0, "MD5": "...", "url": "https://github.com/Imperium-MC/ImperiumClient/releases/download/v<version>/imperium-client-<version>.jar" }
}
```

Add its dependencies as further `FabricMod` modules, including Fabric API and anything else its `fabric.mod.json` declares in `depends`. `FabricMod` files go in the shared `mods/fabric` store, and the launcher passes the enabled ones to Fabric. They are not copied into the instance folder.

#### 3. Performance pack (`FabricMod` modules plus `File` configs)

The Fabulously-Optimized-based pack is not one file. Each mod is its own `FabricMod` module: Sodium, Lithium, FerriteCore, ImmediatelyFast, EntityCulling, ModernFix, and so on, all built for 26.3.

- Use `"required": { "value": false, "def": true }` for mods players may switch off in the launcher's Mods tab. Leave `required` out for mods Imperium Client depends on.
- Point `url` at the Modrinth CDN (`cdn.modrinth.com/...`) rather than re-hosting jars, unless a mod's licence permits redistribution.
- Ship FO's config defaults as `File` modules with an explicit `path`, for example `{ "type": "File", "id": "sodium-options", "artifact": { "path": "config/sodium-options.json", ... } }`. `File` paths are relative to the instance folder (`instances/<server id>/`).

#### 4. Server resource pack (`type: "File"`)

```json
{
    "id": "romanica-resourcepack",
    "name": "Romanica Resource Pack",
    "type": "File",
    "artifact": { "size": 0, "MD5": "...", "path": "resourcepacks/Romanica.zip", "url": "https://<pack host>/Romanica.zip" }
}
```

Use the same zip the server advertises in `server.properties` (`resource-pack` / `resource-pack-sha1`). Then the pack is already on disk at join, and the server prompt only has to enable it. Update both together, or players download it twice.

Optional `File` modules worth shipping alongside it:

- `options.txt` with `resourcePacks:["vanilla","file/Romanica.zip"]`, so the pack is enabled on first launch. It overwrites the player's options on every update, so ship it only if that's acceptable.
- `servers.dat` with the server pre-added to the multiplayer list.

#### 5. Minecraft 26.3 itself

You don't list it. The launcher fetches the vanilla client, libraries and assets from Mojang using `minecraftVersion`.

## Generating it

Writing MD5s and sizes by hand doesn't scale. This repo has its own generator, [`scripts/generate-distro.cjs`](../scripts/generate-distro.cjs); [Nebula](https://github.com/dscalzi/Nebula), Helios' index generator, is the upstream alternative. It builds the index from a folder layout (`servers/<server-id>-26.3/fabricmods/required/*.jar`, `files/...`), resolves the Fabric profile and its libraries, and computes every hash. Run it in CI whenever the pack changes, then upload the output next to the files it references.

## Checklist before switching `REMOTE_DISTRO_URL`

- [ ] `minecraftVersion` is `26.3` and `javaOptions` asks for Java 25
- [ ] Exactly one `Fabric` module, with a `VersionManifest` submodule and every library from its profile
- [ ] Imperium Client and all of its declared dependencies
- [ ] Performance pack mods, each one built for 26.3
- [ ] Resource pack zip matches the server's `resource-pack-sha1`
- [ ] Every artifact URL returns 200, and every `size` and `MD5` matches the file served
- [ ] A clean install (delete `%APPDATA%\Romanica Launcher` and `%APPDATA%\.imperiumlauncher`) launches and auto-joins `play.imperium-mc.net`
