# playpen

Per-project [Lima](https://lima-vm.io) VMs for running coding agents without
handing them your host filesystem. The project directory is mounted read-write
at the same path inside the guest; nothing else of yours is.

```
cd ~/projects/api
playpen claude
```

## Requirements

- Linux host with Lima ≥ 2.0 and QEMU
- Node ≥ 23.6 with TypeScript support (runs `.ts` directly, no build)

`playpen doctor` checks both.

## Install

```
git clone <repo> playpen && cd playpen
npm install
ln -s "$PWD/src/cli.ts" ~/.local/bin/playpen
```

## Commands

```
playpen up                       create or start the sandbox for this directory
playpen shell                    shell in the guest
playpen run [--keep] -- <cmd>    run a command, then stop the VM
playpen claude [--keep] [args]   run Claude Code, then stop the VM
playpen setup                    re-run the project's setup steps
playpen ls | stop | rm --yes
playpen image show | doctor
```

`playpen claude` copies an allowlist from `~/.claude` (instructions, settings,
skills, plugins, OAuth token). `--no-auth` withholds the token, API-key settings
and account identity. `--no-sync` skips the rest.

## Config

Optional `playpen.config.ts` in the project root:

```ts
export default { masked: ["node_modules"], setup: ["npm ci"] };
```

| Key      | Type       | Effect                                                  |
| -------- | ---------- | ------------------------------------------------------- |
| `masked` | `string[]` | Project-relative dirs given guest-local storage, not 9p |
| `setup`  | `string[]` | Shell commands run in the guest, after masks, in order  |

- `masked` gives host and guest their own copy of a path: the 9p share is slow,
  and the two often need different contents there — native modules and toolchain
  builds are per-platform, and the environments drift.
- Masked is not hidden. The host copy stays mounted underneath and the guest has
  root. Keep secrets outside the project.
- `setup` runs on create and after a rebuild, never on start. Nothing is
  inferred from a lockfile. `playpen setup` re-runs it.
- The file is imported on the host and runs as you. `setup` commands do not —
  they run in the guest.
- playpen prints the file and asks before executing it, again whenever it or
  anything it imports changes. Approvals live outside the project, so a sandbox
  cannot approve its own edits.
- No terminal, no approval: the file is not executed, and you get neither masks
  nor setup.

Reasoning in `docs/spec.md`.

## Scope

Threat model is the host filesystem. Network egress is unfiltered. See
`docs/PLAN.md` for known rough edges and `docs/spec.md` for the design.
