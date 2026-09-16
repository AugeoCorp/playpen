# Where this project is

Handoff note, written 2026-09-15. `docs/spec.md` holds the design and the
reasoning; this file covers what actually exists and what to do next.

## What works

`playpen` boots a Lima VM per project with the working directory mounted
read-write, and runs Claude Code inside it. Verified end to end on a Bazzite
host with Lima 2.2.0:

- `playpen up` — creates or starts the sandbox for the cwd, leaves it running
- `playpen shell` — interactive shell in the guest, landing in the project dir
- `playpen run [--keep] -- <cmd>` — runs a command, then stops the VM
- `playpen claude [--keep] [--no-auth] [--no-sync] [--force-sync]` — Claude Code in
  the guest, authenticated, then stops the VM
- `playpen ls` / `stop` / `rm --yes` / `doctor` / `image show`

Boot from scratch is ~90s (cached cloud image); restarting a stopped sandbox is
~20s. 71 unit tests, `tsc --noEmit` clean, one runtime dependency (citty).

## How it's built

Plain Node with no build step — Node 24 runs `.ts` directly, so there is no
bundler and no transpile. `tsconfig.json` sets `erasableSyntaxOnly` so the
compiler rejects syntax type-stripping can't handle (`enum`, `namespace`,
parameter properties) rather than letting it fail at runtime.

The sandbox image is a TypeScript value (`src/image/base.ts`) rendered to a Lima
template. JSON is valid YAML 1.2, so `serialize()` emits JSON and skips a YAML
dependency entirely. Layer packages collapse into one apt transaction; layer
scripts become `provision` entries guarded by a marker keyed to the image hash,
because **Lima re-runs provision scripts on every boot** — without the guard,
every restart would re-provision.

## Sharp edges, in the order they'll bother you

**The image is frozen at creation.** An existing sandbox boots from its own
stored `lima.yaml`, so editing a layer or `playpen.config.ts` does not reach it.
`up` warns and tells you to rebuild, but rebuilding is a full ~90s boot plus
reinstalling everything. This is the most annoying thing about the tool today.

**`up` leaves the VM running with nothing to reap it.** `run` and `claude` both
stop on exit, but `playpen up` by design does not, and there is no idle timer —
an 8GiB reservation sits there until you run `playpen stop`. Idle auto-stop was
deferred to v1 as a nice-to-have; a forgotten VM turned up twice within half an
hour of the tool working, so the deferral looks wrong.

**No retention or gc.** Each sandbox is ~2GB in `~/.lima/playpen-*` and nothing
reaps them. `session/retention.ts` from the spec is unwritten.

**No git identity or credentials in the guest.** An agent inside can commit but
cannot push.

**The guest cannot run playpen's own test suite.** The `node()` layer installs
Ubuntu's `nodejs` package, which on 26.04 is v22.22.1 — and playpen needs ≥23.6
to run `.ts` without a build step. Worse, that build is not compiled with
TypeScript support at all, so even `--experimental-strip-types` fails with
`ERR_NO_TYPESCRIPT`. `npm test` inside a sandbox dies on every file;
`npx tsc --noEmit` works, because that is just TypeScript. Dogfooding playpen on
playpen therefore does not work today, which makes this worth more than its
apparent size. Fixing it means pinning Node from NodeSource or nvm rather than
apt. Workaround: compile out and run the JS —
`npx tsc --noEmit false --rewriteRelativeImportExtensions --outDir <dir>`.

## Design decisions worth not relitigating

- **Ephemeral vs named was dissolved, not chosen.** Sessions decay; `pin`
  exempts one from collection. You can't tell at create time whether a session
  will matter, so playpen doesn't ask.
- **No egress filtering in v0.** The threat model addressed is the host
  *filesystem*, not exfiltration. See the deferred section of `spec.md` for why
  guest-side filtering is a guardrail rather than a boundary.
- **`~/.claude` sync is an allowlist** (`src/session/claudeconfig.ts`). It must
  stay one: that directory also holds every session transcript, 150K+ of shell
  history, and per-project memories for unrelated projects. An early version
  globbed `projects/*/memory` and leaked memories from seven other projects into
  this sandbox — the allowlist is what prevents a repeat.
- **`~/.claude.json` is copied through a keep-list, and must stay that way.** It
  lives *outside* `~/.claude`, so the `SYNC_SET` allowlist misses it — and
  without it the guest looks like a first run and demands a login despite valid
  credentials being present. `filterClaudeJson()` names the ~12 keys that cross
  and drops the rest, taking 76 keys down to 12 on a real config. `projects` is
  kept but narrowed to the current directory: that entry carries the
  directory-trust flag which suppresses the "do you trust these files" prompt,
  while the whole map names every directory you have ever opened.

  It was a denylist until 2026-09-15 — it narrowed `projects` and passed
  everything else through, which let `githubRepoPaths` cross intact, naming
  three unrelated repos and their host paths inside the sandbox. The key was
  incidental; the defect was that new keys defaulted to being copied. Claude
  Code adds top-level keys regularly, so this must not be inverted back.
  `mcpServers` is now dropped too, since server definitions can carry tokens —
  if a sandbox ever needs MCP, add it deliberately.
- **Project config is `playpen.config.ts`, imported on the host.** It replaced
  `.playpenignore` on 2026-09-15: a structured config has room for the options
  v1 needs, and `masked` says what the entries actually do — the internals had
  said `masks` all along. `.js` is accepted too, so a non-TypeScript project
  needs no toolchain to name two directories. A leftover `.playpenignore` is
  detected and warned about, never read.

  **Importing it executes the project's code on the host**, before any VM
  exists. That was chosen deliberately, with the trade understood: pointing
  playpen at an untrusted repo would run its code as you, and because the
  project directory is mounted read-write, an agent inside a sandbox could
  write the file and have the host execute it on the next `up`.

- **That execution is gated by a pin on the config's import graph**
  (`src/session/trust.ts`, `src/session/configgraph.ts`). The pin lives in
  `$XDG_DATA_HOME/playpen/trust/<sandbox>.json` — under the data directory,
  never in the project. That location is the entire point: the sandbox mounts
  only the project directory, so nothing inside a guest can reach the record
  and approve its own config. A graph that matches its pin is imported
  silently; one that is new or edited stops and shows you every new or changed
  file, in full, before asking. Approving `playpen.config.ts` does not bless a
  `playpen.config.js` that appears later, and a pin is scoped to one sandbox.

  Three things about the pin were found and fixed in the 2026-09-15 audit, and
  each is a constraint on future changes:

  1. **It hashes the graph, not the file.** The first version pinned only
     `playpen.config.ts`; a config that imported `./helper.ts` stayed "trusted"
     after an agent rewrote the helper — reproduced, code ran on the host.
     `readConfigGraph` now follows every static relative import (`import`,
     `export … from`, literal `import()` and `require()`) and hashes the set.
     Only project files can be in the graph: an import that resolves outside
     the project, or a bare package name (whose exports-map resolution a static
     scan cannot mirror), is refused and the config is not executed. Imports
     of project files are supported on purpose — this repo's own config does it.
  2. **It executes a snapshot, not the project file.** The bytes that were
     hashed are written under `trust/<sandbox>/` and imported from there. On an
     existing sandbox the VM can be running while `up` checks the config, and
     a guest could rewrite the file between the hash and the `import()`.
  3. **The prompt is not truncated.** The first version showed 40 lines; a
     payload at line 41 would have been approved unseen. Unchanged files in a
     re-prompt are listed by name only, everything new or changed is printed
     whole.

  It fails closed without a terminal: `playpen run` from a script will not
  execute an unapproved config, it warns and runs unmasked. Declining is also
  non-fatal for the same reason — masks are a performance feature, so losing
  them is a degraded run rather than a broken one. Pins survive `playpen rm`,
  on the theory that re-creating a sandbox for a repo you already read should
  not re-prompt.

  Not done, and worth considering if the prompt proves too weak a gate: import
  the snapshot in a child process under Node's permission model
  (`node --permission --allow-fs-read=<snapshot dir>`), so approved code still
  runs but cannot write, spawn, or reach the network.

- **The mount guard protects playpen's own state** (`src/session/mountguard.ts`).
  Beyond `/`, `$HOME`, its parents and the system directories, it refuses to
  mount anything that is, contains, or is inside the data directory (the pins),
  `LIMA_HOME` (Lima's SSH keys and disks) or `~/.claude` (every transcript). It
  only matters if someone runs `playpen up` in one of those places, but that
  is exactly the mount that would let a guest approve its own config.
- **`--no-auth` withholds every credential-shaped thing, not just the token.**
  `settings.json` is rewritten in transit: `env`, `apiKeyHelper`,
  `awsAuthRefresh` and `awsCredentialExport` are dropped unless credentials
  were asked for, because `env` is where `ANTHROPIC_API_KEY` lives. The same
  flag drops `oauthAccount` and `userID` from `~/.claude.json`. `--no-sync`
  now actually skips the config; before, either flag pushed everything.

- **A mask is not a privacy control.** A 9p mount is a bind mount of a directory and cannot omit subpaths,
  so each entry is shadowed by a guest-local directory bind-mounted over it. The
  host directory is still mounted underneath, and the guest has passwordless
  root, so a `umount` reaches it. The real benefits are speed and correctness:
  `node_modules` lands on the VM's ext4 instead of 9p, and host-built binaries
  are the wrong arch for the guest anyway. The docs said "invisible from inside
  the sandbox" until 2026-09-15; that wording invited putting secrets in there,
  which does not work. Keep secrets outside the project directory instead.
- **btrfs CoW-on-CoW is known and deliberately unaddressed.** `~/.lima` is btrfs
  without `nodatacow`, so qcow2 images get copy-on-write twice over. `doctor`
  warns. Fixing it means `chattr +C` on an empty directory, which was judged
  premature without a measurement.

## Next step

The base-image-plus-clone optimization from `spec.md`. Bake one provisioned
`playpen-base-<hash>` instance, then `limactl clone` it per sandbox. That fixes
the frozen-image problem (rebuilds become cheap) and cuts creation time.

It needs a spike first, because Lima's docs don't say whether `clone` requires a
stopped source or whether it reflinks the qcow2 — and on btrfs that determines
whether retaining several sessions is affordable or expensive. The fallback is
already in place and working: render a full template per sandbox and
`limactl start` it.

## Running the tests

```
npm run typecheck
npm test
```

Both are pure functions with no Lima dependency. Anything touching real VMs is
manual today; `spec.md` lists the integration checks that should be automated
behind `PLAYPEN_E2E=1`.
