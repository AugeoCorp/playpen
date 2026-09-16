# Plan

Updated 2026-09-15. Design and reasoning are in `spec.md`; constraints that
must not be inverted are in `AGENTS.md`. Update this when status changes.

## Status

Works end to end on Bazzite, Lima 2.2.0, Node 24. 71 unit tests, `tsc` clean.
Cold boot ~90s, restart ~20s.

| Area                                                             | State                  |
| ---------------------------------------------------------------- | ---------------------- |
| `up` `shell` `run` `ls` `stop` `rm` `doctor` `image show`        | done                   |
| `playpen claude` with `~/.claude` allowlist sync and `--no-auth` | done                   |
| `playpen.config.ts` masks, trust gate on config execution        | done, verified on host |
| `image build`, base image + clone                                | not started            |
| `resume` `pin` `gc` `status`, titles, retention                  | not started            |
| E2E harness (`PLAYPEN_E2E=1`)                                    | not started            |

## Known problems

- An existing sandbox never picks up image or config changes; rebuild is a
  full ~90s reprovision. Step 1 fixes this.
- `up` leaves 8GiB running until `stop`. Idle auto-stop deferred to v1; a
  forgotten VM happened twice in the first half hour, so revisit.
- Nothing collects old sandboxes (~2GB each). Step 2.
- The guest's Node cannot import `.ts`, so playpen cannot run its own tests
  inside a sandbox. Step 3. Check the version first: the spike's base resolved
  to Ubuntu 26.04, not the 24.04 this was measured on.
- No git identity or credentials in the guest; agents can commit, not push.
  Step 3.

## Next

### 1. Base image and clone

Bake `playpen-base-<hash>` once, `limactl clone` it per sandbox.

Spiked 2026-09-15 on Lima 2.2.0 + btrfs, plain Ubuntu base: clone reflinks and
is free -- 0.07s, 0.00B exclusive against 2.03GiB shared. Cold boot of a clone
is 10s, against ~90s to reprovision. Provisioning that unlayered base took
38s, which is the floor for `image build`. Two constraints it turned up: `clone`
refuses a running source, so a baked base is stopped and never started again;
and it prompts to start the new instance, so `up` must pass `--tty=false`.

Because a reclone is ~10s, a sandbox on a stale image hash should reclone
rather than warn. That discards guest-local state, including masked paths.

Done when `image build` exists, `up` clones, and timings for the real layered
image are here.

### 2. Sessions

`retention.ts`: stateless `reap(now)`, collects unpinned **stopped** sessions
oldest-first over a disk budget, lockfile, injected clock, called by every
command. Then `gc --dry-run`, `pin`/`unpin`, `resume`, titles from the spec's
fallback chain, disk usage in `ls`. A running session is never collected.

### 3. Guest toolchain

Pin the `node()` layer to a Node that runs `.ts`, if apt's `nodejs` on the
current base is not already new enough; add git identity and a push
credential path. Both change the image hash, so after step 1.

### 4. E2E harness

The spec's eleven checks behind `PLAYPEN_E2E=1`. The trust prompt's
interactive branch stays manual.

### 5. Later, each small

- Run the config snapshot under `node --permission --allow-fs-read=<snapshot>`
  so approved code cannot write, spawn, or reach the network.
- macOS: `doctor` crashes on missing `findmnt`/`lsattr`; `vmType` is
  hardcoded to `qemu` where `vz` + `virtiofs` is native.
- Idle auto-stop. Host-side egress filtering per the spec.

## Tests

```
npm run typecheck
npm test
```

Inside a sandbox, compile out first:
`npx tsc --noEmit false --rewriteRelativeImportExtensions --outDir <dir>`.
