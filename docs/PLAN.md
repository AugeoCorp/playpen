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
- The guest's Node (Ubuntu's v22) cannot import `.ts`, so playpen cannot run
  its own tests inside a sandbox. Step 3.
- No git identity or credentials in the guest; agents can commit, not push.
  Step 3.

## Next

### 1. Base image and clone

Bake `playpen-base-<hash>` once, `limactl clone` it per sandbox. Spike first:
Lima's docs do not say whether `clone` needs a stopped source or reflinks the
qcow2, and on btrfs that decides whether retention is affordable. Fallback is
today's full template per sandbox.

Done when `image build` exists, `up` clones, and cold/warm timings are here.

### 2. Sessions

`retention.ts`: stateless `reap(now)`, collects unpinned **stopped** sessions
oldest-first over a disk budget, lockfile, injected clock, called by every
command. Then `gc --dry-run`, `pin`/`unpin`, `resume`, titles from the spec's
fallback chain, disk usage in `ls`. A running session is never collected.

### 3. Guest toolchain

Pin the `node()` layer to a Node that runs `.ts`; add git identity and a push
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
