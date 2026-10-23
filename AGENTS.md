# Working agreement for agents (and humans)

**The standing question: "Does this actually do what it says?"** Before calling anything done, prove it works in the real thing. Compiling, type-checking or a green unit run is not proof.

## Evidence, not claims

Every PR that fixes a bug or adds behaviour includes **evidence from a real run** in its description. "Tests pass" alone doesn't count. Evidence means one of:

- a link to a **CI run** that exercised the change, with the relevant log lines or artifacts: the launcher smoke workflow, the client gametest workflow, or a test job
- a screenshot of the changed UI from a CI artifact (gametest screenshots) or a website preview
- a `curl` against the deployed or preview endpoint with its status and body

**Never launch Minecraft, or the launcher's game, on the agent machine.** Only Claude, running on the owner's PC, launches Minecraft. In-game evidence comes from the GitHub Actions workflows (start them with `workflow_dispatch` when they don't run on push). If something can only be checked on a real PC, such as performance numbers, Microsoft sign-in, the installer or a GPU-specific bug, list it under "Not verified" with exact steps. Claude on the owner's PC runs those checks and reports back on the PR.

If you couldn't verify something, write **"Not verified: <what and why>"** in the PR. Never write "fixed" for something you haven't seen fixed. A wrong "fixed" costs the owner more than an honest "not verified".

## Tests must be able to fail

- A test that would pass with the fix reverted proves nothing. For a bug fix, write the test first and see it fail on the old code. Say so in the PR.
- A CI step that runs zero tests must fail, not go green. Check the reported count.
- Smoke and integration checks read only output from *this* run, never files left over from a previous one.
- Tests never touch real user data (configs, saves, `%APPDATA%`). Use temp directories.

## Finish the job

- Search for every occurrence before saying a rename or migration is complete. Paste the grep that comes back empty.
- When a spec issue lists N items, the PR states which of the N it covers. Leftovers go in a comment on the issue, not silently dropped.
- Don't release, tag or update the distribution index until the evidence above exists for that build.

## Owner rules

- Never rotate, print or commit secrets.
- Kill processes by exact PID only, never by matching a command line.
- Don't commit Mojang assets. Don't copy files or assets from other clients.
- Don't name other clients in commit messages, README or PRODUCT.md (`docs/` is fine).
- The brand is **Romanica**, the domain is **romanica.net**, and the API is **api.romanica.net**. `imperiummc.net` is retired and being transferred. Never reference it in new code.
- Commits use minimal conventional format (`fix:`, `feat:`, `chore:`), one logical change each.

## How to verify in this repo (RomanicaLauncher)

- `npm test` and `npx eslint app test scripts`. Files are CRLF, which lint enforces.
- **Real launch:** start the **`smoke.yml`** workflow on your branch (`gh workflow run smoke.yml --ref <branch>`). It builds the launcher and boots the full client on a Windows runner with Mesa. Link the run, and quote the verdict plus the first line of the uploaded `latest.log` from the `smoke-artifacts` artifact. Don't run the smoke driver or the game on the agent machine.
- Anything touching natives, Java arguments or the classpath: also confirm zero `UnsatisfiedLinkError` in that artifact's game log.
- Auth or Microsoft login and installer or auto-update behaviour can't be fully exercised in CI. List them under "Not verified" with steps for Claude on the owner's PC.
- Release only after `smoke.yml` passes on the release commit. Upload the exe, the blockmap and `latest.yml` together.

## Lessons from past misses (don't repeat)

- The natives "fix" shipped in five releases (0.1.4 to 0.2.4) and was wrong each time. The real search path is the `-Djava.library.path` argument in the version manifest. It was only proven by a launch with no workaround.
- `npm test` once deleted the owner's real launcher config. Tests now stub `APPDATA`; keep it that way.
- The smoke driver passed on the previous run's `latest.log`, then killed the launcher and the just-started game with it. Every "PASS" before PR #9 was hollow.
- The generated distro gave jars names like `9.0.0-fabric-undefined.jar` because the artifact ID was missing. Check generated output, not only that the generator ran.
