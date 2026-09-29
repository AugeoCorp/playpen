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
- Node ≥ 23.6 with TypeScript support (runs `.ts` directly, no build);
  `mise install` gives you the pinned one from `mise.toml`
- [bubblewrap](https://github.com/containers/bubblewrap) and
  [socat](http://www.dest-unreach.org/socat/), for the network fence
  (`brew install socat` on a Homebrew host)

`playpen doctor` checks all of it.

## Install

```
git clone <repo> playpen && cd playpen
npm install
ln -s "$PWD/src/cli.ts" ~/.local/bin/playpen
```

## Commands

```
playpen start                    create or start the sandbox for this directory
playpen shell [--keep]           shell in the guest, then stop the VM
playpen run [--keep] -- <cmd>    run a command, then stop the VM
playpen claude [--keep] [args]   run Claude Code, then stop the VM
playpen setup                    re-run the project's setup steps
playpen list | stop [--force] | remove --yes [--force]
playpen image show | doctor
playpen completion bash|zsh      print a completion script for that shell
```

`up`, `ls` and `rm` still work, and tab-complete to the full name.

Tab completion, once per shell:

```
playpen completion bash > ~/.local/share/bash-completion/completions/playpen
playpen completion zsh  > "${fpath[1]}/_playpen"
```

Sessions in the same project share one VM. The last one to exit stops it, so
quitting one `playpen claude` no longer cuts off another. `stop --force` and
`remove --force` override that and cut every session off; they are only needed
while one is attached. `playpen list` shows the count under `ATT`, and the
sandbox's network fence under `NET`: `sealed` (fenced, gatekeeper answering, and
the guest proved it can reach it), `no egress` (fenced with a gatekeeper, but
the guest cannot reach it -- check
`playpen run -- systemctl status playpen-tun2proxy`), `no gate` (fenced, but no
gatekeeper is answering -- run `playpen start`), `OPEN` (running outside the
fence -- stop it and start it again), or `-` (stopped).

`playpen claude` copies an allowlist from `~/.claude` (instructions, settings,
skills, plugins, OAuth token). `--no-auth` withholds the token, API-key settings
and account identity. `--no-sync` skips the rest.

## Config

Optional `playpen.config.ts` in the project root:

```ts
export default { masked: ["node_modules"], setup: ["npm ci"] };
```

`examples/playpen.config.ts` shows every key, with a note on each.

| Key       | Type                                                                                                     | Effect                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `masked`  | `string[]`                                                                                               | Project-relative dirs or files: the guest gets its own copy, and the host's contents stay out of it           |
| `setup`   | `string[]`                                                                                               | Shell commands run in the guest, after masks, in order                                                        |
| `network` | `{ allow?: string[]; mode?: "enforce" \| "log"; ports?: (number \| { host: number; guest: number })[] }` | Hosts this project may reach, on top of the ones playpen ships, and host ports it sees at its own `localhost` |

- `masked` gives host and guest their own copy of a path, a directory or a file:
  the 9p share is slow, and the two often need different contents there — native
  modules and toolchain builds are per-platform, and the environments drift. The
  guest's copy starts empty, is writable, and survives stop and start.
- The host's contents stay out of the VM while the host path is not replaced
  under a running VM, so `masked: [".env"]` keeps a secret in the project out of
  the VM, even from a guest that unmounts its own mask. The fence's helper binds
  an empty read-only placeholder over the path where qemu serves the share. That
  is fixed when the VM starts: an entry added to a running sandbox is masked in
  the guest at once, and keeps the host's contents out after
  `playpen stop && playpen start`, which `start` says.
- Editing a masked path on the host in place is safe. Replacing it (an editor
  that saves by rename, `sed -i`, `git checkout`,
  `rm -rf node_modules && npm ci`) detaches the placeholder, so the helper
  checks for that every few seconds and stops the sandbox when it happens; the
  guest can see the new contents until it does. Start it again afterwards.
- A masked path that is missing on the host is created by the guest, as an empty
  directory on the host. For a file such as `.env`, create it on the host first
  (`touch .env`). `start` refuses a masked path that is a symlink or under one,
  and a nested one whose parent directory is gone.
- `setup` runs on create and after a rebuild, never on start. Nothing is
  inferred from a lockfile. `playpen setup` re-runs it.
- `network.allow` is a list of names, not addresses: an entry is a hostname,
  optionally with a port, and covers that name and everything under it, so
  `*.example.com` is rejected — `example.com` already says it. Named with a
  port, it may resolve to a LAN address as well as a public one, on that port
  alone; named without one, it must resolve to a public address. Neither ever
  reaches this machine — only `localhost:PORT` does that. Link-local addresses
  and the 0.0.0.0 spelling of loopback are never reached either way. An IPv4
  literal is the other address you can name: it needs a port, and it may be on
  your LAN, but never an address of this machine.
- `localhost:PORT` means your machine, not the guest's: the computer running
  playpen, on that one port. Inside the guest, `localhost` still means the guest
  itself and never leaves the VM, so the guest reaches your machine by the name
  `host.playpen.internal` instead: `http://host.playpen.internal:11434/` gets to
  your Ollama if and only if `localhost:11434` is listed. The port is required;
  a bare `localhost` would mean every service on your machine and is rejected.
- `network.ports` puts a port on your machine at the guest's own `localhost`
  too, for a client in the guest you cannot point at `host.playpen.internal` —
  an MCP server configured as `http://localhost:4321/`, say. `1234` is the same
  port on both sides; `{ host: 1234, guest: 4321 }` moves it. An entry is a
  grant of that host port, so it implies `localhost:1234` and you do not list
  that as well; the gatekeeper logs each connection as
  `host.playpen.internal:1234`, like any other. The guest port must be free in
  the guest: `playpen start` warns and carries on if something there already
  holds it. A stdio MCP server is a process, not a port, and this does not cover
  it.
- `mode: "log"` records what the sandbox reaches and blocks nothing on the
  internet side; your own machine's localhost stays closed in every mode. Use it
  to find the hosts a project needs, then list them; the default is `enforce`.
- The file is imported on the host and runs as you. `setup` commands do not —
  they run in the guest.
- playpen prints the file and asks before executing it, again whenever it or
  anything it imports changes. Approvals live outside the project, so a sandbox
  cannot approve its own edits.
- No terminal, no approval: the file is not executed, and you get neither masks
  nor setup.

Reasoning in `docs/spec.md`.

## Scope

Threat model is the host filesystem. A sandbox VM also runs inside a network
namespace with no route out of it: every connection the guest opens arrives at a
gatekeeper on the host, which allows it by name or refuses it. Guest root cannot
reach around that, but an allowed destination is still a way out --
`docs/NETWORK.md` says what this does and does not contain. See `docs/PLAN.md`
for known rough edges and `docs/spec.md` for the design.
