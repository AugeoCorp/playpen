# Plan

Updated 2026-09-15. Design and reasoning are in `spec.md`; constraints that must
not be inverted are in `AGENTS.md`. Update this when status changes.

## Status

Works end to end on Bazzite, Lima 2.2.0, Node 24. Baking the base takes ~75s
once; a sandbox then clones from it and boots in 10s. Restart ~20s.

| Area                                                               | State                  |
| ------------------------------------------------------------------ | ---------------------- |
| `start` `shell` `run` `list` `stop` `remove` `doctor` `image show` | done                   |
| `playpen claude` with `~/.claude` allowlist sync and `--no-auth`   | done                   |
| `playpen.config.ts` masks, trust gate on config execution          | done, verified on host |
| `image build`, base image + clone                                  | done, verified on host |
| `completion bash\|zsh`, generated from the citty command tree      | done; zsh unverified   |

## Known problems

- An existing sandbox does not pick up image or config changes, or a rebaked
  base, on its own. `start` notices both and offers a ~10s rebuild; declining
  keeps the old one running.
- `start` leaves 8GiB running until `stop`. Idle auto-stop deferred to v1; a
  forgotten VM happened twice in the first half hour, so revisit.
- Nothing collects old sandboxes, old bases, or history archives. A clone costs
  almost nothing, but every `image build --force` and every image change leaves
  a ~2GB base behind. Unscheduled. Whatever does it cannot just delete:
  `destroy` boots a stopped sandbox to archive its Claude history, so collecting
  N sandboxes costs N boots unless they are archived on stop instead.
- Node 26 from nodejs.org and mise are both in the base, verified in a booted
  guest from wiped mise state: `npm test` runs natively (80 pass, nothing
  skipped, no compile-out); a project pinning `.node-version` installs and
  resolves it on the first login shell (~7s cold, ~30ms after); one pinning
  nothing falls through to the floor with no output.
- `setup` in `playpen.config.ts` runs project-declared commands in the guest on
  create and rebuild, with `playpen setup` to re-run. Config parsing and the
  guest ordering are unit-tested; the actual run needs a host with `limactl`.
- Sessions in a project share a VM and hold leases, so the last one out stops
  it. Unit-tested with a fake Lima client; confirmed by hand with two
  `playpen claude`. A session killed before its cleanup leaves a lease behind;
  it is dead, so the next read reaps it.
- The completion scripts hold no command names: they ask `playpen __complete` on
  each keypress, which reads citty's own tree, so a new command completes
  without reinstalling anything. ~60ms per press; ~130ms for zsh, whose menu
  descriptions force every command module to load. The bash script was driven
  headlessly against real `COMP_WORDS`; nothing on this host has zsh, so the zsh
  script is syntax-unchecked and untried.
- No git identity or credentials in the guest; agents can commit, not push. Step
  2, and the only thing that blocks the core workflow.

## Next

### 1. Base image and clone — **done**

Bake `playpen-base-<hash>-<date>` once, `limactl clone` it per sandbox.

Spiked 2026-09-15 on Lima 2.2.0 + btrfs, plain Ubuntu base: clone reflinks and
is free -- 0.07s, 0.00B exclusive against 2.03GiB shared. Cold boot of a clone
is 10s, against ~90s to reprovision. The unlayered base provisioned in 38s; the
real layered one takes ~75s, most of it installing Claude Code. Two constraints
it turned up: `clone` refuses a running source, so a baked base is stopped and
never started again; and it prompts to start the new instance, so `start` must
pass `--tty=false`.

Base names carry the build date so you can see how old one is:
`playpen-base-<hash>-2026-09-15`. It is a label, not an expiry. Since the date
is outside the hash, lookup matches `playpen-base-<hash>-*` and takes the
newest; `image build --force` bakes a new dated base from the same definition,
which is how you pick up current packages.

Two things make a sandbox stale: its rendered template no longer matches the one
written at creation, or a newer base exists than the one it was cloned from.
`start` offers a rebuild rather than doing it -- a reclone is ~10s but discards
installed packages and masked directories, and `start` is routine. Claude
transcripts and memory are archived across it. Without a TTY it declines.

One base for now. `playpen.config.ts` does not choose an image.

A clone inherits the base's instance config, which is Lima's _resolved_ yaml:
`base:` consumed, `images:` filled in. Lima rejects a config that still has
`base:`, so playpen's rendered template cannot replace it -- `start` rewrites
only the empty `mounts` key the base leaves behind. Not `limactl edit --set`
either: lima builds yq with env operations disabled, so the cwd cannot be passed
as `strenv()`, and interpolating it is injectable. `guard()` markers are baked
in, so provisioning stays skipped.

Masks therefore cannot be a provision entry -- nothing can add one to a clone.
They run from the host over `limactl shell` after every start, which they had to
do anyway since a bind does not survive a reboot. Changing `masked` now takes
effect on the next `start` without a rebuild.

Consequence: cpus, memory, disk and mountType come from the base, so they cannot
yet vary per sandbox. They are global defaults today.

- [x] `image build`, with `--force` for a fresh dated bake
- [x] base naming, lookup by hash, newest wins
- [x] `start` clones and fills in the clone's empty `mounts`
- [x] `list` hides bases
- [x] a stale sandbox offers a rebuild instead of only warning
- [x] a sandbox on an older base than the newest is offered one too
- [x] `~/.claude/projects` is archived on destroy and restored on create, so a
      rebuild keeps transcripts and the memory directory; round-trip verified on
      the host 2026-09-15
- [x] verified on the host: a fresh sandbox clones and boots in 10s, with no
      package installs and no image download

### 2. Guest toolchain

Pin the `node()` layer to a Node that runs `.ts`: apt's `nodejs` on Ubuntu 26.04
is v22.22.1, which cannot. Add git identity and a push credential path. Both
change the image hash, so every existing sandbox will be offered a rebuild the
next time it is used.

### 3. Run playpen inside playpen

Nested virtualisation works in a sandbox today -- `/dev/kvm` is present and
`vmx` is exposed -- so the E2E checks could run there instead of on the host.
That removes the operator from the loop for every VM-touching change, and is
safer than host E2E: nested instances live in the guest's own `~/.lima` and
cannot reach real sandboxes, which host-side tests avoid only by naming.

Two things it cannot cover, which stay manual on the host: the guest disk is
ext4, so `clone` copies instead of reflinking, and KVM-in-KVM boots in tens of
seconds. Reflink and timing claims are only measurable on btrfs.

The open cost is where qemu and limactl live. In the base image they are ~100MB
every sandbox carries; installed on demand they are ~700MB re-downloaded after
every reclone. Decide alongside preset bases.

First test to write once this works: `start`, write a file under
`~/.claude/projects`, `remove --yes`, `start` again, assert it came back.
Verified by hand once already, so this is about keeping it true. Automated
checks otherwise stay out of the way -- manual testing has been finding the real
bugs.

### 4. Later, each small

- Run the config snapshot under `node --permission --allow-fs-read=<snapshot>`
  so approved code cannot write, spawn, or reach the network.
- macOS: `doctor` crashes on missing `findmnt`/`lsattr`; `vmType` is hardcoded
  to `qemu` where `vz` + `virtiofs` is native; the bash completion script uses
  `mapfile`, which the bash 3.2 Apple ships does not have.
- Idle auto-stop. Host-side egress filtering per the spec.
- Preset bases, selected from `playpen.config.ts`; later, defined there. Needs a
  cap or a GC story first: bases share no extents with each other, so one image
  per project is one full copy per project.

## Tests

```
npm run typecheck
npm test
```

Inside a sandbox, compile out first:
`npx tsc --noEmit false --rewriteRelativeImportExtensions --outDir <dir>`.
