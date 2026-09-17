# Option C mechanism -- prototype

Two scripts, both asserting the properties `docs/NETWORK.md` claims under
"Option C". Measured 2026-09-17 on Linux 6.18.

- `prototype.sh` -- the mechanism with no VM. 7 checks, all passing.
- `lima-fenced.sh` -- the same thing with a real Lima 2.2.0 VM inside the fence.
  13 checks, all passing.

`relay.ts` carries connections across the fence, and `../mitmproxy/allowlist.py`
is the policy, unchanged from the earlier spike and unchanged by the move from
local mode to `socks5`.

## What the Lima run proves

```
1. the fence
  ok    bubblewrap keeps our own uid
  ok    and still brings loopback up
  ok    with no route out of it
2. Lima inside it
  ok    the VM boots with no network under it
3. the control path
  ok    limactl reaches the VM from out here, before any bridge
  ok    and reaches it once bridged, with nothing joining the fence
4. what the guest can and cannot reach
  ok    no internet from the guest
  ok    192.168.5.2 reaches the fence's own loopback
  ok    the egress chain works from outside the fence
  ok    and the relay on 192.168.5.2 carries the guest out
5. policy still governs what comes through
  ok    killing the proxy severs the guest (fails closed)
  ok    the proxy saw the domain and denied it
  ok    and the guest got nothing
```

The guest pulled 46MB of the PyPI index through that chain, so this is real
traffic rather than a handshake that happened to complete.

Two assumptions the design rested on, both confirmed against the real thing
rather than reasoned:

- **qemu owns the ssh listener.** Lima builds
  `-netdev user,...,hostfwd=tcp:<addr>:<port>-:22`, and `ss` names
  `qemu-system-x86` as the process holding it. So fencing qemu fences the
  listener, and the control path is ours to bridge.
- **`192.168.5.2` reaches the fence's own loopback.** The guest fetched a page
  from a server bound to `127.0.0.1` inside the namespace. The host-loopback
  hole really does become the door.

## What it cost to get there

**Bubblewrap is the only unprivileged fence that works.** Two other routes were
tried and both fail:

- `unshare -Urn` maps you to uid 0 inside the namespace, and `limactl` refuses
  to run as root.
- `unshare -n --map-current-user` keeps your uid and `limactl` is happy, but
  exec as a non-root uid drops the capabilities the namespace granted, so
  loopback cannot be brought up. A namespace without loopback is useless here.

`bwrap --unshare-net` gets all three at once: your own uid, loopback up, no
route out. It is also the one thing nobody can join from outside, which is why
the control path has to be bridged rather than entered.

**Lima's ssh control socket already crosses the fence.** `limactl shell` reached
the guest from outside _before_ the control bridge existed, because Lima leaves
an ssh ControlMaster socket in `~/.lima/<instance>/`, and a socket file does not
care about network namespaces. The bridge works too and is what survives the
master connection going away, but the free path is worth knowing about.

## Traps

- **Lima copies the host's proxy environment into the guest, `no_proxy`
  included.** A `no_proxy` entry turns the guest's proxy setting off for exactly
  those hosts, so in a sealed box they become unreachable rather than direct,
  and the error says `Could not resolve host`. This cost an hour of chasing a
  design bug that was not there.
- **An allowed host is passed through undecrypted**, so the guest verifies the
  real certificate. On a machine whose own egress is TLS-intercepted, the guest
  has no reason to trust the intercepting CA: `GUEST_CURL_OPTS=-k` or install
  it.
- **Abstract unix sockets do not cross a network namespace**; path sockets do.
  Measured both ways. An abstract socket gets connection refused with nothing in
  the error to say why.
- **A socket file outlives its process**, so a stale one refuses connections and
  blocks a rebind. `relay.ts` unlinks before binding.
- **A fresh namespace has loopback down.** bubblewrap handles it; anything else
  has to.

## Running them

`prototype.sh` needs `mitmdump` on PATH
(`uv tool install --python 3.13 mitmproxy`) and `iproute2`.

`lima-fenced.sh` also needs `bwrap`, `node`, and Lima **2.2.0 or newer** run as
an ordinary user. Lima 1.0 passes `accel=kvm` unconditionally and cannot start
without `/dev/kvm`; 2.2.0 falls back to software emulation, which is how this
ran. Nothing here needs root.

```
GUEST_CURL_OPTS=-k ./lima-fenced.sh
```

## Still not answered

The VM ran under software emulation, so nothing here says anything about timing,
and `stop`/`start` of a fenced instance across a reboot of the fence has not
been exercised. Neither bears on whether the mechanism holds.
