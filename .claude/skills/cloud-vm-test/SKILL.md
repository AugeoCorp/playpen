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
works, slowly: a sandbox boot takes a few minutes, and baking the base image
much longer.

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

## Bake the base

Do not let `pp start` bake it. The container's outbound HTTPS is intercepted,
and the guest does not trust the interceptor's certificate, so every
`curl https://…` in provisioning fails. Claude Code, Node and tun2proxy never
install, the readiness probe for `claude` waits until Lima's timeout, and
playpen deletes the half-built base. The error is only
`did not receive an event with the running status`; it is not a timeout to
raise.

`bake-base.ts` writes playpen's own base template with one extra first step that
makes the guest trust the container's interception CAs: the certificates in
`/opt/ca-bundle.crt` that are not public roots. There are two interceptors, the
agent proxy and an egress gateway the guest's direct traffic goes through, so it
takes them all. It also puts `NODE_EXTRA_CA_CERTS` in the template's `env` for
npm, which keeps its own CA list. It uses the name playpen looks for. Bake it,
then stop it, since `limactl clone` refuses a running source:

```
set -- $(setpriv --reuid runner --regid runner --init-groups env -i \
  HOME=/home/runner PATH=/opt/node/bin:/usr/bin:/bin \
  XDG_DATA_HOME=/home/runner/pp-data \
  node .claude/skills/cloud-vm-test/bake-base.ts)
su runner -c "limactl start --name=$1 --tty=false --timeout=60m $2 && limactl stop $1"
```

Every sandbox cloned from that base trusts the interceptors too, which its own
`curl`s need. The base is otherwise playpen's, so a test of anything but
provisioning is unaffected; say so in the PR if provisioning is what changed.

Follow provisioning while it runs with
`su runner -c "limactl shell --workdir / $1 sudo tail /var/log/cloud-init-output.log"`.
A step that failed shows as
`WARNING: Failed to execute /mnt/lima-cidata/provision.system/0000000N`.

## Run

Put a `playpen.config.js` in the scratch project, then `pp start`.

Approvals need a terminal, and `node --test` and a plain Bash call have none.
There are two ways around that:

- Answer the prompts for real, which tests the prompts themselves. Run under
  `script` and feed answers with a delay, one per prompt:
  `(sleep 20; echo y; sleep 20; echo y; sleep 1800) | script -qfec 'pp start' start.log`.
  The trailing `sleep` keeps the terminal open until the sandbox is up.
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
is kept, so the next `start` clones it.

Say in the PR which parts ran against the VM and which did not.
