---
name: cloud-vm-test
description:
  Run playpen end to end against real Lima VMs inside a Claude Code cloud
  container (Ubuntu, root, no KVM). Use when a change touches a real VM, its
  mounts, the network fence, or `playpen start`, and AGENTS.md asks for it to be
  verified by hand.
---

# Testing playpen against a real VM in a cloud container

The container has no `/dev/kvm`, so QEMU runs under software emulation (TCG). It
works, slowly. Later boots take about 3 minutes. Baking the base image took
about 11 minutes in one container, and in another it ran past the 20 minutes
`createAndStart` in `src/lima/client.ts` allows, so playpen deleted the
half-built base.

If `start` or `image build` fails with
`did not receive an event with the running status`, bake the base by hand from
the template playpen kept, with more time, and stop it. playpen finds a base by
its name, so the next `start` clones it as usual:

```
T=$(ls /home/runner/pp-data/playpen/templates/playpen-base-*.yaml)
N=$(basename "$T" .yaml)
su runner -c "limactl start --name=$N --tty=false --timeout=60m $T && limactl stop $N"
```

To see where provisioning is while it runs:
`su runner -c "limactl shell --workdir / $N sudo tail /var/log/cloud-init-output.log"`.

## Set up

```
sh .claude/skills/cloud-vm-test/setup.sh
```

As root. It is safe to re-run. It installs QEMU, socat, bubblewrap and
openssh-client from apt, Lima 2.2.0 from the GitHub release, and Node 24 in
`/opt/node`. The container's Node 22 cannot strip types, so neither the CLI nor
`lifecycle.test.ts` runs on it. It also creates the `runner` user, because
`limactl` refuses to run as root, and gives that user a readable copy of the
egress proxy's CA. Without the CA, the host-side network helper cannot reach
real hosts. It ends with `pp doctor`.

`pp <args>` is `playpen <args>` run as `runner`, in `$PP_CWD` (default
`/home/runner/scratch`), with `XDG_DATA_HOME=/home/runner/pp-data`. It runs the
repo's `src/cli.ts` in place, so it always runs the checked-out code. It starts
from `env -i`, so the container's tokens never reach the test user.

Downloads go to github.com, nodejs.org and cloud-images.ubuntu.com. The session
needs read access to lima-vm/lima, or the proxy answers 403.

## Run

Put a `playpen.config.js` in the scratch project, then `pp start`.

Approvals need a terminal, and `node --test` and a plain Bash call have none.
There are two ways around that:

- Answer the prompts for real, which tests the prompts themselves. Run under
  `script` and feed answers with a delay, one per prompt:
  `(sleep 20; echo y; sleep 20; echo y; sleep 3000) | script -qfec 'pp start' start.log`.
  The trailing `sleep` keeps the terminal open through the bake.
- Pre-approve, when the prompts are not what you are testing. Call `pinConfig`
  on the result of `readConfigGraph`, and `pinMounts` for read-only mounts, both
  from `src/session/trust.ts`. Run it as `runner`, with the same
  `XDG_DATA_HOME`.

Inside scripts, close stdin for `pp run -- …` with `</dev/null`, or it eats the
rest of the script.

Look inside the guest with `pp run -- sh -c '…' </dev/null`. Check what Lima was
handed in `/home/runner/.lima/<instance>/lima.yaml`, and check QEMU's arguments
with `ps -eo args | grep -o -- '-virtfs [^ ]*'`.

Smoke test for the fence: `pp run -- curl -sI https://nodejs.org` is allowed. A
host not on the allow list is refused and logged in
`$XDG_DATA_HOME/playpen/net/<sandbox>/gatekeeper.log`. `src/network/e2e.ts` is
the fuller fence test; read its header for the environment it needs.

## Clean up

Only stop or delete playpen's own instances: `pp stop`, or `pp remove --yes` in
the scratch project. Leave the scratch sandbox stopped when done. The baked base
is kept, so the next `start` skips the bake.

Say in the PR which parts ran against the VM and which did not.
