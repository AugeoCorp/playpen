# Network containment

This describes what the network fence actually does, not the options that were
weighed to get here. Those are in "Rejected on the way" below, kept for the
record; the mechanism itself is in `src/network/`.

## What it does

The sandbox VM's host process (qemu, and the Lima hostagent that drives it) runs
inside a network namespace with no route out of it -- a namespace is a private
copy of the kernel's network stack, so a process in one sees only loopback and
nothing else, no matter what it tries. The only way out is a unix socket, a
named connection point on the filesystem rather than the network, that crosses
into a process waiting on the host side. That process is the gatekeeper: every
outbound connection the guest opens arrives there as an HTTP `CONNECT` (the
request a browser or proxy client sends to ask for a tunnel to some host and
port), and the gatekeeper allows it or refuses it by hostname before any real
connection opens. The guest has passwordless root, but root inside the namespace
still has no route around it -- the boundary sits in a namespace guest root
cannot leave, not in anything guest root could turn off. If the gatekeeper or
its helper process dies, the guest is left with no network at all, never with an
open one: the fence fails closed. None of this needs host root. It runs as an
ordinary user.

## The shape

Three layers: the guest, the fence (an unprivileged network namespace made with
`bwrap --unshare-net`), and the host. Two paths cross it: the agent's own
traffic going out, and `limactl shell` coming in.

**Traffic out.** The guest runs `tun2proxy-bin`, a program that reads packets
from a tun device -- a virtual network interface the kernel routes packets to
instead of a real one -- and hands each one to an HTTP proxy. It is started as a
systemd unit (`tun2proxy()` in `src/image/layers.ts`) that lays the device and
the routes down itself before running:

```
tun2proxy-bin --proxy http://192.168.5.2:1080 --tun tun0 --dns virtual
```

`192.168.5.2` is the address Lima's user-mode networking gives the guest for
reaching "the host". `--dns virtual` makes tun2proxy answer the guest's DNS
lookups itself with synthetic addresses from `198.18.0.0/15`, so a request still
carries the hostname when it reaches the proxy, and no name ever needs to leave
the guest separately.

The unit's `ExecStartPre=` lines do what tun2proxy's own `--setup` would: create
`tun0`, address it, and route `0.0.0.0/1` and `128.0.0.0/1` over it, which take
the default route without replacing it. `--setup` itself is not used because it
fails on the 26.04 base's kernel
(`Failed to set up TProxy: Received a netlink error message Invalid argument (os error 22)`)
before it ever creates the tun, crash-looping the unit; the same binary and
flags work on kernel 6.8. Nothing has to be kept off the tun by hand: eth0's
connected route for `192.168.5.0/24` is more specific than `0.0.0.0/1`, so the
ssh connection Lima drives the guest through stays on eth0.

DNS needs one more step, because the guest resolves through systemd-resolved and
its uplink is qemu's own resolver on eth0, which is inside the fence with no
route out. The unit runs `resolvectl dns tun0 198.18.0.1` and
`resolvectl domain tun0 '~.'`, which makes tun0 the resolver link for every
domain, so the query goes into the tunnel and tun2proxy answers it.
`ExecStopPost=` reverts both and deletes the device, so `Restart=always` starts
from a clean interface.

Because qemu itself runs inside the fence, `192.168.5.2` is not the real host's
loopback -- it is the fence's own. Inside the fence, a `socat` process listens
on `127.0.0.1:1080` and connects each incoming stream to `egress.sock`, a unix
socket. A second `socat` outside the fence listens on that same socket path and
forwards each connection to the gatekeeper's own `127.0.0.1:<port>`. The
gatekeeper (`proxy-chain`, in `src/network/gatekeeper.ts`) reads the `CONNECT`
target, decides by hostname (`src/network/policy.ts`), and either pipes the
connection through or refuses it with a 403 before any upstream socket is
opened.

```
guest                    fence (network namespace)              host
-----                    --------------------------              ----
tun2proxy      --------> qemu (slirp): 192.168.5.2 is the
  -> 192.168.5.2:1080      fence's own loopback, not the host's
                         inside socat 127.0.0.1:1080
                           -> UNIX-CONNECT egress.sock -----> outside socat
                                                                 UNIX-LISTEN egress.sock
                                                                 -> TCP 127.0.0.1:<port>
                                                                    gatekeeper: allow / deny
```

**`limactl shell` in.** Lima normally multiplexes shells over its own ssh master
connection, `ssh.sock`, which is a plain file -- a unix socket crosses a network
namespace freely, since it is looked up by filesystem path, not by address, and
`bwrap` here only isolates the network, not the filesystem. So an ordinary
`limactl shell` keeps working for as long as that master connection lives. When
it does not -- the master died, or a shell is opened fresh -- a new connection
would have to reach the guest's forwarded ssh port over TCP, and that port is
bound inside the fence's own loopback, unreachable from outside. The fallback is
`control.sock`: the fence's inside half runs a `socat` that listens on that path
and forwards to the guest's ssh port, and every shell playpen opens sets `$SSH`
(`sshThroughControl` in `src/lima/client.ts`) to an `ssh` whose `ProxyCommand`
is `socat - UNIX-CONNECT:control.sock`. Lima runs `$SSH` in place of `ssh` when
it is set, so this reaches the guest without anything outside ever joining the
namespace.

## Lifecycle

`playpen start` writes the merged policy (the built-in list plus the project's
`network.allow`) to disk, then spawns the helper process detached so it outlives
the command that started it. The helper starts the gatekeeper and the two
relays, brings the VM up inside a fresh `bwrap` namespace, and waits for the
guest to answer before returning -- streaming its own log to the terminal in the
meantime. If a VM is already running and fenced with a live helper, `start`
leaves the VM alone but still writes the policy, and says so when the file
changed. If the VM is up but its helper died, `start` reattaches: a new
gatekeeper and relay, no new namespace, since qemu and the inside relays were
never the helper's children to lose.

**policy.json is what the gatekeeper decides on**, not the copy the helper
started with. The helper stats the file on the same few-second pass that watches
the VM, and re-reads it whenever it has been rewritten, logging the new entry
count to helper.log; so a project that tightens its `network.allow` and
re-approves needs no restart, and a host removed from the list stops being
reachable within a few seconds. A policy.json that will not parse is a corrupt
file rather than a half-written one -- it is written by rename -- so the helper
swaps in an empty enforcing policy and says so: the sandbox loses its network
until the next `playpen start` rather than keeping a list nobody can read.

**The guest is then asked to prove it can reach the gatekeeper**, because none
of the above does: everything the helper knows is from outside the fence, where
a guest whose `playpen-tun2proxy` died looks exactly like a healthy one. The
helper runs one `curl` in the guest for `probe.playpen.internal`, driven over
Lima's own control path so the answer covers both directions, and watches for
the verdict in `gatekeeper.log`. `probe.playpen.internal` is a reserved name
(`PROBE_HOST` in `src/network/policy.ts`): `decide` always answers it with a
`probe` verdict, which the gatekeeper refuses with the same 403 as a deny --
nothing is dialed and no allow entry is needed, and the log line is the whole
signal. A guest that has not answered within about a minute (tun2proxy's unit
retries every 2 s) is recorded as `egress: false` in the helper's record.

The helper keeps running either way and the VM stays up: it is fenced and
usable, which is what a sandbox with a broken tunnel needs in order to be
repaired. `start` says so and points at
`playpen run -- systemctl status playpen-tun2proxy`, and `playpen list` shows
the sandbox as `no egress` for as long as it stays that way.

`playpen stop` goes through Lima's own instance files, fence or no fence --
stopping never has to know about the namespace. The helper notices the VM is no
longer running on its own (it polls every few seconds) and exits, tearing the
fence down behind it: gatekeeper closed, both sockets removed, its own record
file deleted.

**If the helper is killed** -- a crash, a `kill -9`, the host running out of
memory -- nothing holds the fence's namespace open but qemu and the Lima
hostagent themselves, and they are not the helper's children in any way that a
signal to the helper reaches. So the VM stays up, still fenced, with no
gatekeeper answering: no egress until the next `playpen start`, which finds it
in that state and reattaches. This is the same case as `stop` disconnecting one
relay without the other: fail closed, not open.

**A host reboot** kills every VM. The fence's leftover files (sockets, the
helper's record) go stale with it; the next `start` finds no qemu process for
the instance, treats it as fully stopped, and builds a fresh namespace from
scratch.

**A VM started outside playpen** -- by hand, with plain `limactl start` -- runs
in the host's own network namespace, not a fenced one. `playpen start` detects
this (`fenceStatus` reads `"unsealed"`) and refuses to attach to it; there is no
unfenced mode to fall back into. The fix is
`playpen stop --force && playpen start`.

## Policy

`decide()` in `src/network/policy.ts` is the whole rule set. It takes a policy
-- the built-in list (`BUILTIN_ALLOW`) plus the project's `network.allow`,
already merged -- and a mode, and applies these rules to every `CONNECT`:

- **A name entry covers its subdomains.** `example.com` matches `example.com`
  and anything ending in `.example.com`; a leading `*.` is rejected when the
  project config is read, since the bare name already means that.
- **`host:port` restricts the entry to that port.** Without a port, an entry
  matches the name on any port.
- **An IPv4 literal can be an entry**, matched only when the guest's request is
  itself that literal address -- an entry does not intercept a name that happens
  to resolve to it, because the gatekeeper decides on the name, not the address.
  A bare IP address in the request that is not explicitly listed is refused (or
  reported, in log mode), the same as any other unlisted host.
- **An IPv4 entry needs a port**, so one entry cannot open every service at an
  address, and it may name a LAN address -- the database on your network is one
  an operator can legitimately approve -- but never a loopback one, nor 0/8,
  link-local or multicast. A ported name entry can reach the same kind of
  address too, if its DNS happens to answer there; see the next rule.
- **An address that is not a public one is refused in every mode**, listed or
  not, when the guest's request names it directly: 0/8 (which Linux reads as
  loopback), 127/8, 169.254/16 with the cloud metadata service in it, the
  RFC1918 and CGNAT ranges, multicast, and 240/4. This machine and the networks
  it sits on are not what log mode opens.
- **A name's port decides how far it may resolve, mirroring an address entry.**
  Named with a port, an entry matches only that port, and the name may resolve
  to a public address, this machine's own loopback, or a LAN or CGNAT address --
  the same reach a `localhost:PORT` or LAN-address entry already has once it
  names one directly. Named without one, it may only resolve to a public
  address, on any port -- today's rule, kept because nothing pins that name's
  DNS to a port an operator chose. Either way, a link-local address and the
  0.0.0.0 spelling of loopback are never dialed: link-local is where a cloud
  metadata service hands out credentials, and 0.0.0.0 is only a strange spelling
  of loopback. The gatekeeper resolves the name it decided on and dials only the
  addresses its reach permits; if none are left, the tunnel is closed and a
  second log line records the address that was refused, and why: not public, or
  not reachable at all. Without the port-less rule, any name whose DNS the
  operator does not control -- and every name at all in log mode, which has no
  entry to carry a port -- would be a way to reach this machine's own loopback.
  IPv4 only: a name with nothing but AAAA records is refused here.
- **`localhost:PORT` in the config** is the deliberate, explicit way to reach a
  service on the host machine itself, and the only one that does not depend on
  some other name's DNS happening to answer there. The guest cannot ask for it
  directly: it has to `CONNECT` to the literal name `host.playpen.internal`,
  which the gatekeeper maps to `127.0.0.1:PORT` only when a matching
  `localhost:PORT` entry exists. The port is required, so one entry cannot open
  every service on the host.
- **The guest's own idea of loopback never reaches the gatekeeper** -- that
  traffic stays inside the guest. A `CONNECT` that literally names `localhost`
  or `127.0.0.1` is therefore read as an attempt to reach the _host's_ loopback
  by the wrong name, and is refused every time, in every mode, with no
  exception. This, and a request whose host or port cannot be parsed at all, are
  the only decisions log mode does not soften.
- **`mode: "log"`** pipes an otherwise-unlisted connection through anyway and
  records what would have been refused, so a project's real host list can be
  found by running it and reading the log. It never opens the host's own
  loopback; only the internet side is permissive.

`BUILTIN_ALLOW` today is `api.anthropic.com`, `statsig.anthropic.com`,
`registry.npmjs.org`, `nodejs.org`, `github.com`,
`objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
`pypi.org`, and `files.pythonhosted.org` -- a guess at what Claude Code and
common package managers need, not a measurement. It stays a guess until a
`mode: "log"` run against real projects replaces it (see "Later").

## What it does not contain

- **An allowed destination is still a way out.** Allow `github.com` and an agent
  can push a branch full of secrets to a repo it controls. The fence stops
  unknown destinations; it says nothing about what an agent does with the ones
  it is allowed to reach.
- **The project mount is the sharing channel, by design.** It was never part of
  what the fence closes.
- **DNS lookups happen at the gatekeeper**, not in the guest and not as a
  separate step a name could sneak through -- `--dns virtual` means the guest
  never resolves anything itself. So a hostname is not a side channel around the
  policy. It is still visible: every verdict, allowed or refused, is logged with
  the host it named.
- **`destroy` briefly runs a stopped sandbox unfenced** to archive its Claude
  history before deleting it (`saveHistory` in `src/session/lifecycle.ts`). For
  those few seconds its egress is unfiltered. See `docs/PLAN.md`.
- **Nothing inspects content.** The gatekeeper decides on the `CONNECT` target
  and then pipes the connection through untouched; it never terminates TLS, so
  it cannot see or alter what travels inside an allowed connection.

## What was measured, and where

`src/network/e2e.ts` is the proof, run by hand against a real Lima VM -- not
part of `npm test`. It boots a plain Ubuntu 24.04 cloud image with none of the
base image's own layers (tun2proxy is copied in and started by hand, since this
VM never ran the `tun2proxy()` layer), and checks 14 steps: the sandbox comes up
behind the gatekeeper; `limactl shell` works over Lima's own socket, and still
works once that socket's master is killed, confirmed by `ss -x -p` naming
`control.sock`; tun2proxy routes the guest to the gatekeeper; an allowed host
answers and a denied one is refused, both logged; a raw socket with no proxy
setting configured still goes through the tun and out; the VM survives the
helper being `SIGKILL`ed, stays fenced with no egress, and a new helper
reattaches and restores it; and `limactl stop` tears the fence down cleanly. All
14 passed, run as an unprivileged user in a container, Lima 2.2.0 under software
emulation.

`playpen start` against a baked base has now been run too, on Ubuntu 26.04
(kernel 7.0.0-28) under the same software emulation: the base's own
`tun2proxy()` unit comes up `active` with nothing done by hand,
`ip route get 1.1.1.1` answers `dev tun0`, `registry.npmjs.org` returns 200
through the chain, a host the project allows and one it does not are logged
`allow` and `deny`, and the helper's probe is logged. Disabling the unit and
starting again produced the `no egress` state, the warning, and `egress: false`;
re-enabling it restored the 200.

What has not been run: a host reboot, and any of this on the maintainer's own
machine.

## Rejected on the way

- **mitmproxy's eBPF local-capture mode.** Redirects one host process's traffic
  by pid. Measured against mitmproxy 12.2.3: the redirect fails open -- kill the
  proxy and traffic flows unfiltered -- which makes it an instrument, not a
  boundary. It also needs `sudo` to load the eBPF program, which means a
  privileged helper process the design would otherwise have no reason to run.
- **A host firewall rule matched on the qemu process's cgroup.** The boundary
  that needs no userspace relay at all, in principle -- but setting it up needs
  root on the host, which the rest of this design avoids entirely.
- **Proxy environment variables in the guest.** They only reach programs that
  read them, so nothing enforces anything for the rest. They also collide with
  Lima's own default of copying the host's proxy variables into the guest
  (`no_proxy` included), which would turn the route off for exactly the hosts
  meant to be reachable -- this is why `propagateProxyEnv: false` is set in
  `src/image/render.ts`.
- **mockttp as the gatekeeper.** It waits for the client's first bytes before
  dialing onward, so any protocol where the server speaks first -- ssh, most
  databases -- stalls forever; refusing a connection at `CONNECT` time is not
  something its public interface exposes, only its internals. It also costs far
  more than `proxy-chain` for a job that is one `CONNECT` decision: about 200
  packages against 9, and 114 MB resident at idle against 73 MB, both measured
  on the same machine.
- **`bwrap --unshare-pid`.** Isolating the process namespace too, not just the
  network one, sounds like it should make the fence tidier. Lima instead reports
  a perfectly healthy instance as `Broken`, so the fence uses `--unshare-net`
  alone and accepts that qemu and the hostagent, not the helper, are what keep
  the namespace alive.

## Later

- **Header injection for named hosts** -- putting a short-lived credential into
  a request without it ever reaching the guest -- sitting behind the gatekeeper,
  likely with mockttp doing the injection once a connection is already known to
  be allowed.
- **Publishing chosen guest ports to the host.** Lima still forwards every guest
  loopback port, but inside the fence, where nothing on the host can reach them;
  a dev server in the guest no longer shows up on the host's `localhost`.
- **A measured built-in list.** See the numbered item in `docs/PLAN.md`.
