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
playpen ls | stop | rm --yes
playpen image show | doctor
```

`playpen claude` copies an allowlist from `~/.claude` (instructions, settings,
skills, plugins, OAuth token). `--no-auth` withholds the token, API-key settings
and account identity. `--no-sync` skips the rest.

## Config

Optional `playpen.config.ts` in the project root:

```ts
export default { masked: ["node_modules"] };
```

`masked` directories get guest-local storage instead of the 9p share. This is
for speed, not privacy: the host copy is still mounted underneath and the guest
has root. Keep secrets outside the project.

The config is imported on the host, so it runs as you. playpen prints it and
asks before executing, again whenever it or anything it imports changes.
Approvals are stored outside the project, so the sandbox cannot approve its own
edits. Without a terminal it runs unmasked instead.

## Scope

Threat model is the host filesystem. Network egress is unfiltered. See
`docs/PLAN.md` for known rough edges and `docs/spec.md` for the design.
