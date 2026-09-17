# Option C mechanism -- prototype

Two scripts, both asserting the properties `docs/NETWORK.md` claims under
"Option C". Measured 2026-09-17 on Linux 6.18.

- `prototype.sh` -- the mechanism with no VM. 8 checks, all passing.
- `lima-fenced.sh` -- the same thing with a real Lima 2.2.0 VM inside the fence.
  16 checks, all passing, including the guest reaching the relay by route as
  well as by proxy setting.

`socat` carries connections across the fence, and `../mitmproxy/verdict.py`
decides what may pass, from a JSON policy file it re-reads per connection.

## What the Lima run proves

```
1. the fence
  ok    bubblewrap keeps our own uid
  ok    and still brings loopback up
  ok    with no route out of it
2. Lima inside it
  ok    the VM boots with no network under it
3. the control path
  ok    limactl reaches the VM over lima's own ssh socket
  ok    and over our bridge, with nothing joining the fence
4. what the guest can and cannot reach
  ok    no internet from the guest
  ok    192.168.5.2 reaches the fence's own loopback
  ok    and the relay on it carries the guest out
5. as a route, with no proxy setting anywhere
  ok    traffic to the internet now leaves via a tun device
  ok    a request that refuses every proxy setting still gets out
  ok    and a raw socket that has never heard of a proxy gets out
  ok    a denied host is still denied on this path
6. policy still governs what comes through
  ok    a denied host is blocked, not merely unreachable
  ok    losing the policy file denies rather than releases
  ok    killing the proxy severs the guest (fails closed)
```

Section 5 runs only with `TUN2PROXY=<binary>`. `--noproxy '*'` makes curl refuse
every proxy setting it can see and bash's `/dev/tcp` has never heard of one, so
between them they show the route carrying traffic the variable could not.

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
  blocks a rebind. Whatever binds it has to unlink first.
- **A fresh namespace has loopback down.** bubblewrap handles it; anything else
  has to.
- **tun2proxy needs `--bypass` for qemu's subnet.** Without it the guest's
  replies to the gateway go into the tunnel and the ssh session dies with them.
- **tun2proxy does not replace the default route**, it overrides it with a
  `0.0.0.0/1` and `128.0.0.0/1` pair. `ip route show default` looks untouched;
  `ip route get` is where the answer is.

## Running them

`prototype.sh` needs `mitmdump` on PATH
(`uv tool install --python 3.13 mitmproxy`), plus `socat`, `node` and
`iproute2`.

`lima-fenced.sh` also needs `bwrap`, `socat`, `node`, and Lima **2.2.0 or
newer** run as an ordinary user. Lima 1.0 passes `accel=kvm` unconditionally and
cannot start without `/dev/kvm`; 2.2.0 falls back to software emulation, which
is how this ran. Nothing here needs root.

```
GUEST_CURL_OPTS=-k TUN2PROXY=/path/to/tun2proxy-bin ./lima-fenced.sh
```

## Still not answered

The VM ran under software emulation, so nothing here says anything about timing,
and `stop`/`start` of a fenced instance across a reboot of the fence has not
been exercised. Neither bears on whether the mechanism holds.
