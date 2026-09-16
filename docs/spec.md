# playpen — v0 spec

## Context

`playpen` is a CLI that manages Lima VMs the way `docker sandbox` manages containers: you sit
in a project directory, run one command, and get an isolated Linux VM with that directory
mounted read-write and a coding agent ready to run inside it. The problem it solves is running
Claude Code (or any agent) against a real project without handing it your host filesystem.

First target is local use on a Bazzite (immutable Fedora) workstation; cross-platform
distribution is explicitly deferred.

### Decisions

- **One VM per sandbox.** Concurrency is "number of projects", not "number of tasks" — the
  agent fans out _inside_ its VM using subagents and worktrees. That keeps concurrency in the
  1–3 range where per-sandbox VMs are cheap and Lima owns the lifecycle for us.
- **Sessions are retained and garbage-collected, never deleted on exit.** This replaces the
  ephemeral-vs-named split entirely.
- **Stop on exit, no pause in v0.** Dropping pause removes the QMP internal, guest clock
  drift, resident RAM, _and_ the entire background-timer subsystem.
- **No egress filtering in v0.** Full network. The threat model v0 addresses is the host
  _filesystem_, not exfiltration.
- **cwd mounted read-write**, at the same path inside the guest so paths in error messages
  match on both sides.
- **Plain Node, no bundler.** Node ≥23.6 runs `.ts` directly with no flag. Verified on this
  box: Node **v24.15.0** runs `.ts` unflagged, so tsup is not needed. Runtime dependencies are
  **just citty**; TypeScript is dev-only for `tsc --noEmit`.

### Assumption to confirm

Claude Code credentials are **copied** into the sandbox at create time
(`limactl copy ~/.claude/.credentials.json`), not live-mounted — the agent gets working auth
without seeing your other projects' history. Each sandbox therefore holds a copy of your
credentials on its disk. `--auth mount|copy|none` selects; `copy` is the default.

---

## Session model

Deciding "ephemeral or named?" at create time is impossible — you don't yet know whether the
session will matter. So playpen never asks. Sessions accumulate and are collected by budget;
you intervene only to keep one.

| State         | Entered by                                        | Resume cost  |
| ------------- | ------------------------------------------------- | ------------ |
| **running**   | `playpen up`, or any command on a stopped session | —            |
| **stopped**   | `playpen run` exiting, or explicit `playpen stop` | ~10–20s boot |
| **collected** | `playpen gc` when over the disk budget            | gone         |

`playpen pin <n>` exempts a session from collection. That _is_ the "named sandbox" feature —
no separate concept, and the decision happens after you have the information to make it.

### Who stops what

Explicitly, rather than via a background timer:

- **`playpen run` stops the VM on exit.** Tidy one-shot.
- **`playpen up` leaves it running.** For iterative work: `up` once, then `run`/`shell` freely
  with no boot cost between commands.
- **`playpen stop`** for when you're done with an `up` session.

The consequence, stated plainly: an `up` session stays running until you stop it. Nothing
auto-stops a _running_ VM in v0, because the only safe way to do that is a timer, and a timer
that can stop a running VM risks killing a long agent run. Idle auto-stop and pause both defer
to v1, where a timer earns its keep.

### Collection

`session/retention.ts` exposes a stateless, idempotent `reap(now)` that collects unpinned
**stopped** sessions once the playpen total exceeds a disk budget, oldest first. Guarded by a
lockfile; clock injected so it unit-tests without waiting.

Safety invariant: **only `stopped` sessions are collectable, ever.** A running session is never
touched however stale its `lastUsed` looks.

Collection isn't time-critical, so it needs no timer — every `playpen` invocation calls
`reap()` before its own work. A stopped VM costs only disk, so "collected slightly later than
ideal" is a non-issue.

Retention is **disk-budgeted, not count-based** — N sessions is meaningless when session size
depends on whether `limactl clone` reflinks. `playpen ls` shows per-session disk usage.

Reboot needs no handling: it kills all VMs and sessions reappear as `stopped`, already a legal
state.

### Titles

Derived from signals already present — **no LLM call**, which would add cost, latency, and an
auth dependency to a cosmetic feature. Fallback chain:

1. First user message in the guest's `~/.claude/projects/<slug>/*.jsonl`, truncated to ~50
   chars. Usually the ideal title verbatim.
2. Git branch of the mounted dir, if not `main`/`master`.
3. Most recent commit subject.
4. `session <date>`.

`playpen pin <n> --as "..."` overrides. All steps are best-effort with fallthrough, so coupling
to Claude's JSONL format is safe — a wrong title is cosmetic.

**What resume actually buys you:** the cwd is a host mount, so files survive regardless. What's
trapped in the VM is installed dependencies, shell history, and Claude's own session history.
Resuming a sandbox resumes the conversation.

---

## The base image, defined in code

The image must be _generatable_, not a hand-maintained YAML file. So it's a TypeScript value
that renders to a Lima template.

```ts
// src/image/base.ts
export const baseImage = defineImage({
	name: "playpen-base",
	distro: ubuntu("24.04"),
	layers: [
		buildTools(), // git, curl, ripgrep, jq, gcc, make
		node({ version: "22" }),
		python({ version: "3.13" }),
		claudeCode(),
	],
});
```

A layer stays deliberately small:

```ts
interface Layer {
	name: string;
	packages?: string[]; // resolved through distro.installCmd()
	script?: string; // shell, run in layer order
	mode?: "system" | "user"; // maps to Lima's provision mode
	env?: Record<string, string>; // appended to /etc/profile.d/playpen.sh
}
```

`render.ts` does two jobs:

1. Flattens layers into a Lima template — every layer's `packages` collapse into **one**
   package-manager transaction (much faster than one per layer), then each `script` becomes a
   `provision:` entry in declaration order.
2. Computes `contentHash` = first 8 hex of sha256 over the canonical JSON of the ImageDef.

That hash is the entire cache-invalidation story: the baked instance is named
`playpen-base-<hash>`, so editing a layer changes the hash, misses the cache, and rebuilds.

`distro` abstracts apt vs dnf (`installCmd(pkgs): string`), making an Ubuntu→Fedora swap a
one-line change. Defaulting to Ubuntu because it's Lima's own default and the best-tested path
— the [mount docs](https://lima-vm.io/docs/config/mount/) call out 9p as incompatible with
several RPM distros, which isn't a fight worth having in week one.

---

## Sandbox lifecycle

1. **`ensureBase()`** — if `playpen-base-<hash>` doesn't exist: render template, `limactl
start`, let provisioning run, `limactl stop`. No mounts, no project files. Once per image
   definition.
2. **`createSandbox()`** — `limactl clone playpen-base-<hash> playpen-<slug> --mount <cwd>:w --start`

**Clone needs validating before step 2 is written.** Lima's docs don't state whether `clone`
requires a stopped source or whether it reflinks the qcow2 — and `~/.lima` is on btrfs, where
qcow2-on-CoW is a known performance trap. This gates **two** things: create speed, and whether
retention is affordable at all (a reflinked clone makes a retained session cost only its delta;
a full copy makes keeping several expensive).

Fallback if clone disappoints: `limactl start --name playpen-<slug>` against the same rendered
template with the mount added — identical image definition, re-provisions per sandbox. **The
image-as-code layer is unaffected either way**, so nothing is blocked on the outcome.

### Identity and state

- Sandbox name: `<basename of cwd>-<6 hex of sha256(abs path)>`, e.g. `playpen-a3f2c1`.
- Lima instance: `playpen-<sandbox name>`. The prefix keeps `limactl list` readable and
  guarantees we never touch a pre-existing `default` instance.
- Metadata: one JSON file per session at `$XDG_DATA_HOME/playpen/sessions/<name>.json` holding
  `{ cwd, created, lastUsed, title, pinned, imageHash }`. **Lima stays the source of truth for
  VM state** — we store only what Lima can't tell us. Hand-deleting a file is harmless.

---

## CLI surface

| Command                                    | Behavior                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `playpen up`                               | Create or start the session for cwd, and leave it running. Idempotent. |
| `playpen shell [name]`                     | Interactive shell. Implies `up`.                                       |
| `playpen run [name] -- <cmd...>`           | Exec a command, then stop the VM.                                      |
| `playpen claude [name] -- [args...]`       | Shorthand for Claude Code in the sandbox.                              |
| `playpen ls`                               | Sessions with title, state, age, disk usage, pin marker.               |
| `playpen resume [n]`                       | Start a stopped session; bare form takes the most recent.              |
| `playpen pin <n> [--as "title"]` / `unpin` | Exempt from collection.                                                |
| `playpen stop` / `rm` / `status`           | Lifecycle passthroughs, scoped to playpen instances.                   |
| `playpen gc [--dry-run]`                   | Collect unpinned stopped sessions over the disk budget.                |
| `playpen image build [--force]` / `show`   | Bake/refresh base; print rendered YAML + hash.                         |
| `playpen doctor`                           | limactl present, Node version, btrfs/CoW warning, mount type sanity.   |

---

## File layout

```
src/
  cli.ts                  runMain(main), lazy subCommands
  commands/
    up.ts shell.ts run.ts claude.ts ls.ts resume.ts pin.ts
    stop.ts rm.ts status.ts gc.ts doctor.ts
    image/{build,show}.ts
  lima/
    client.ts             typed wrappers over limactl (list uses --format json)
    template.ts           Lima instance YAML types
  image/
    types.ts              Layer, ImageDef, defineImage
    distro.ts             ubuntu()/fedora(), installCmd()
    layers/{build-tools,node,python,claude-code}.ts
    base.ts render.ts
  session/
    identity.ts           cwd -> session name
    store.ts              metadata persistence
    title.ts              title derivation chain
    retention.ts          disk budget, collection policy
    lifecycle.ts          ensureBase, create, attach, stop, destroy
  sh.ts                   node:child_process wrapper: inherit-stdio + capture variants
  config.ts               ~/.config/playpen/config.toml
```

citty subcommands load lazily (`() => import("./commands/up.ts").then(m => m.default)`) so
`playpen ls` doesn't pay for the image module graph.

### Node-without-a-build constraints

`tsconfig.json` sets `erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`, and
`allowImportingTsExtensions: true`. The first makes the compiler **reject** syntax type
stripping can't handle (`enum`, `namespace`, parameter properties) rather than letting it fail
at runtime; the others keep imports honest. Relative imports carry explicit `.ts` extensions
because this is ESM. `tsc --noEmit` is the only type-check step.

Install is a shim in `~/.local/bin/playpen` invoking `node <repo>/src/cli.ts`.

---

## Build order

1. **Scaffold** — this spec, tsconfig, citty skeleton, `sh.ts`, `doctor`.
2. **Image as code** — `src/image/*` + `image show` / `image build`. Done when
   `playpen image show | limactl validate -` passes and an unchanged definition skips rebuild.
3. **Lifecycle** — `up`, `shell`, `run` (with stop-on-exit), `ls`, `stop`, `rm`, `status`.
   Clone vs plain-start gets measured here, where it first matters.
4. **Sessions** — titles, `resume`, `pin`, `gc`.
5. **Agent ergonomics** — `playpen claude`, auth copy.
6. **Polish** — config file, `~/.local/bin` shim, README with measured timings.

---

## Verification

**Unit (`node --test`)** — pure functions, no Lima:

- `identity.ts`: same cwd → same name; different cwd → different name.
- `render.ts`: hash stable across runs, _changes_ when a layer changes; packages collapse to
  one install command; layer order preserved.
- `title.ts`: each fallback step fires when the prior signal is absent.
- `retention.ts`: never selects running or pinned sessions; respects the disk budget.

**Integration** — gated behind `PLAYPEN_E2E=1`, boots real VMs:

1. `playpen image build` → `limactl list` shows `playpen-base-<hash>` stopped.
2. `playpen up` in a scratch dir → instance running.
3. `playpen run -- ls <cwd>` → lists host files, proving the mount.
4. Write a file guest-side, assert it appears on the host — proves `:w` round-trips.
5. `playpen run -- true` → session reports `stopped` afterward.
6. `playpen up` then `playpen run -- true` → session still `running` afterward.
7. `playpen resume` → back to `running`.
8. `playpen up` again in the same dir → reattaches, does **not** create a second instance.
9. `playpen claude -- -p "reply with OK"` → proves auth passthrough end-to-end.
10.   `playpen gc --dry-run` with a tiny budget → selects oldest unpinned stopped only.
11.   `playpen rm` → `limactl list` clean, metadata gone.

**Manual:** `time playpen up` cold vs warm, recorded in the README so the clone-vs-start
tradeoff rests on numbers rather than a guess.

---

## Out of scope for v0

Pause/resume via QMP, idle auto-stop and its background timer, egress allowlisting,
`limactl sync`-style copy-in/diff-out mounts, containers-in-VM as a fast backend, VM pooling,
and cross-platform binaries. The CLI surface above is shaped so each lands as an addition
rather than a rewrite.

### Deferred: egress filtering

Recorded here so the reasoning isn't lost. Lima has no documented escape hatch for raw QEMU
args ([issue #932](https://github.com/lima-vm/lima/issues/932)), so `netdev restrict=on` is not
readily available. Two tiers were considered:

- **Guest-side** nftables + an SNI-allowlist proxy. Cheap, but Lima gives the guest passwordless
  sudo, so the agent can flush it. A guardrail, not a boundary.
- **Host-side**, which is the real one: slirp means guest traffic leaves the host as the _qemu
  process's_ traffic, so launching each VM in a systemd scope and matching `socket cgroupv2` in
  host nftables enforces the allowlist somewhere the guest cannot reach. Needs one-time root
  setup and verification that Lima's hostagent doesn't fork qemu out of the scope.

Either way, an allowlist cannot stop exfiltration to an _allowed_ host — allow github.com and
an agent can push a branch full of secrets. It blocks unknown destinations; it is not a
data-loss control.
