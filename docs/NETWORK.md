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

Lima's own host resolver is off in the baked template
(`hostResolver: { enabled: false }` in `src/image/render.ts`). Left on, it
answers the guest's queries to `192.168.5.3` using the host's own resolver, and
on a host whose `nsswitch.conf` lists `resolve` (Fedora and Bazzite ship this)
that resolver is a unix socket to systemd-resolved. A unix socket crosses this
fence the same way `egress.sock` does, so a guest with root had a DNS tunnel
out. With the resolver off, `192.168.5.3` is qemu's own forwarder, which sends
plain UDP to the host's nameservers; inside the fence that has no route. The
helper also runs its `bwrap` with `--tmpfs /run/systemd/resolve` and
`--tmpfs /var/run/nscd` (each only when the directory exists on the host), so
those sockets are hidden inside the fence before the guest ever starts, so
nothing inside the fence's namespace can reach them by path either.

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

**Host ports at the guest's own `localhost`.** Some clients in the guest cannot
be pointed at `host.playpen.internal` -- an MCP server configured as
`localhost:4321`, say. A `network.ports` entry covers that: `1234` puts the
host's port 1234 at the guest's `127.0.0.1:1234`, and
`{ host: 1234, guest: 4321 }` puts it at `127.0.0.1:4321`. The helper runs one
`socat` per entry in the guest, as a transient systemd unit
(`playpen-port-<guest>`, started with `systemd-run --collect`):

```
socat TCP-LISTEN:4321,bind=127.0.0.1,fork,reuseaddr PROXY:192.168.5.2:host.playpen.internal:1234,proxyport=1080
```

so each connection reaches the gatekeeper as a `CONNECT` to
`host.playpen.internal:1234` over the same address tun2proxy uses, and is
decided and logged there like any other: it is not a second way out. An entry is
an explicit grant of that host port, so `playpen start` adds `localhost:1234` to
the allow list for it; the project does not write both. `decide()` never sees
`ports` at all. The units are set up once the helper's start check is done, and
again on every policy reload: one whose entry went away is stopped, a new one is
started, and one that stayed is left running, so its open connections survive
the reload. A helper reattaching to a running VM does not know what the last one
started, so it stops them all first. socat is installed by the base image's
build-tools layer.

The guest port must be free in the guest. If something there already listens on
it, or the unit is not active a second after starting, the helper names it in
helper.log and in its record, and `playpen start` warns that the host port is
not at that guest port -- without failing the start. A stdio MCP server is a
process the guest runs, not a port, so nothing here applies to it.

## Lifecycle

`playpen start` writes the merged policy (the built-in list plus the project's
`network.allow`, a `localhost:<host>` for each of its `network.ports`, every
host named by `network.secrets`, and the ports and secrets themselves) to disk,
then spawns the helper process detached so it outlives the command that started
it. The helper starts the gatekeeper and the two relays, brings the VM up inside
a fresh `bwrap` namespace, and waits for the guest to answer before returning --
streaming its own log to the terminal in the meantime. If a VM is already
running and fenced with a live helper, `start` leaves the VM alone but still
writes the policy, and says so when the file changed. If the VM is up but its
helper died, `start` reattaches: a new gatekeeper and relay, no new namespace,
since qemu and the inside relays were never the helper's children to lose.

**policy.json is what the gatekeeper decides on**, not the copy the helper
started with. The helper stats the file on the same few-second pass that watches
the VM, and re-reads it whenever it has been rewritten, logging the new entry
count to helper.log; so a project that tightens its `network.allow` and
re-approves needs no restart, and a host removed from the list stops being
reachable within a few seconds. A policy.json that will not parse is a corrupt
file rather than a half-written one -- it is written by rename -- so the helper
swaps in an empty enforcing policy and says so: the sandbox loses its network
until the next `playpen start` rather than keeping a list nobody can read.

**helper.json carries a `policy` field**, alongside `ready` and `egress`: the
stamp (`mtime:size` of policy.json) of the policy the gatekeeper is deciding
with right now. When `playpen start` runs against a sandbox that is already up
and the policy file changed, it waits up to 15 s for the helper to report that
stamp, then prints "network policy updated for new connections"; if the wait
runs out it fails instead, with "the running sandbox has not picked up the new
network policy". A new policy decides new connections only: a tunnel already
open stays open, since the gatekeeper decides once, at `CONNECT` time.

**The guest is then asked to prove it can reach the gatekeeper, and that the
gatekeeper actually refuses something**, because neither is proven by the above:
everything the helper knows so far is from outside the fence, where a guest
whose `playpen-tun2proxy` died looks exactly like a healthy one, and a
gatekeeper that let everything through would look exactly as healthy as one that
enforces the policy. The helper runs `curl` in the guest for two reserved names,
driven over Lima's own control path so the answer covers both directions, and
watches for both verdicts in `gatekeeper.log`:

- `probe.playpen.internal` (`PROBE_HOST` in `src/network/policy.ts`): `decide`
  always answers it with a `probe` verdict, refused with the same 403 as a deny
  -- nothing is dialed and no allow entry is needed.
- `deny.playpen.internal` (`DENY_HOST`): a name no policy can allow, in either
  mode -- always refused, never dialed. Its `deny` line is what proves the
  gatekeeper is capable of refusing anything at all, not only that traffic
  happens to get through.

Only once both a `probe` line and a `deny` line land in `gatekeeper.log` does
the helper report `egress: true` and the sandbox read as `sealed`. A guest that
has not produced both within about a minute (tun2proxy's unit retries every 2 s)
is recorded as `egress: false` in the helper's record.

The helper keeps running either way and the VM stays up: it is fenced and
usable, which is what a sandbox with a broken tunnel needs in order to be
repaired. `start` says so and points at
`playpen run -- systemctl status playpen-tun2proxy`, and `playpen list` shows
the sandbox as `no egress` for as long as it stays that way.

`playpen stop` goes through Lima's own instance files, fence or no fence --
stopping never has to know about the namespace. The helper notices the VM is no
longer running on its own (it polls every few seconds) and exits, tearing the
fence down behind it: gatekeeper closed, both sockets removed, its own record
file deleted, and `killFenceLeftovers` (`src/network/fence.ts`) `pkill -9 -f`s
anything still matching the sandbox's `egress.sock` path, its `control.sock`
path, or `__net-inside <sandbox> ` -- so nothing from this fence outlives the
VM, including inside socats a killed helper left running for a reattach that
never came.

**If the helper is killed** -- a crash, a `kill -9`, the host running out of
memory -- nothing holds the fence's namespace open but qemu and the Lima
hostagent themselves, and they are not the helper's children in any way that a
signal to the helper reaches. So the VM stays up, still fenced, with no
gatekeeper answering: no egress until the next `playpen start`, which finds it
in that state and reattaches. This is the same case as `stop` disconnecting one
relay without the other: fail closed, not open. The inside socats survive the
kill on purpose, so a reattach has something to reattach to; they do not outlive
the VM itself -- whichever helper eventually notices the VM has stopped kills
them along with the rest of the fence (see `playpen stop`, above).

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
  an operator can legitimately approve -- but never an address of this machine,
  nor 0/8, link-local or multicast. A ported name entry can reach the same kind
  of address too, if its DNS happens to answer there; see the next two rules.
- **Every address this machine has is refused, in every mode.** Every IPv4
  address on one of the host's interfaces -- loopback, LAN or public -- is
  refused whether the request names it or a name resolves to it, listed or not,
  in log mode too. The log gives the reason as "an address of this machine".
  `localhost:PORT` is the one entry that reaches this machine, through
  `host.playpen.internal` (below). An unlisted address that is neither public
  nor LAN is refused as well: 0/8 (which Linux reads as loopback), 127/8,
  169.254/16 with the cloud metadata service in it, multicast, and 240/4.
- **A name's port decides how far it may resolve.** Named with a port, an entry
  matches only that port, and the name may resolve to a public address or a
  LAN/CGNAT one -- the same reach an address entry with a port already has, and
  never this machine's own, whatever address that name's DNS happens to answer
  with. Named without one, it must resolve to a public address. The port is what
  makes the difference: an entry like `internal.foo.com:8080` is as deliberate
  as `localhost:8080`, while a bare name's DNS is the domain owner's to change,
  so it is never let inside. Either way, link-local (where a cloud metadata
  service hands out credentials) and the `0.0.0.0` spelling of loopback are
  never dialed. The gatekeeper resolves the name it decided on, dials only an
  address its reach permits that is not one of this machine's own, and when
  nothing is left closes the tunnel and logs a second line naming the refused
  address. IPv4 only: a name with nothing but AAAA records is refused.
- **`localhost:PORT` means the host machine, not the guest.** The config is read
  on the host, so `localhost` there is the computer running playpen, and the
  entry opens that one port on it. Inside the guest, `localhost` is the guest
  itself and that traffic never reaches the gatekeeper, so the guest asks for
  the host by the name `host.playpen.internal` instead, which the gatekeeper
  maps to `127.0.0.1:PORT` only when a matching `localhost:PORT` entry exists.
  It is the honest spelling when no DNS name is involved, and the only route to
  the host that does not depend on some other name's DNS answering there. The
  port is required: a bare `localhost` would mean every service on the host, and
  is rejected when the config is read. A `network.ports` entry brings its own
  `localhost:<host>` entry (see "Host ports at the guest's own `localhost`"
  above), and its connections arrive as `host.playpen.internal:<host>` like any
  other, so this rule is the only one they meet. A `network.secrets` host brings
  its own bare entry the same way, and the fence's own names are refused there,
  so no secret can be named for this machine.
- **The guest's own idea of loopback never reaches the gatekeeper** -- that
  traffic stays inside the guest. A `CONNECT` that literally names `localhost`
  or `127.0.0.1` is therefore read as an attempt to reach the _host's_ loopback
  by the wrong name, and is refused every time, in every mode, with no
  exception. This, and a request whose host or port cannot be parsed at all, are
  the only decisions log mode does not soften.
- **`mode: "log"`** pipes an otherwise-unlisted connection through anyway and
  records what would have been refused, so a project's real host list can be
  found by running it and reading the log. It never opens an address of this
  machine -- named directly or reached by resolving a name -- and never opens
  the guest's own loopback; only the internet side, and a LAN address for a
  ported entry, is permissive.

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
- **The project mount is the sharing channel, by design,** and so is the
  sandbox's Claude history directory, mounted at the guest's
  `~/.claude/projects`. Neither was ever part of what the fence closes.
- **DNS lookups happen at the gatekeeper**, not in the guest, for every program
  that uses the guest's own resolver: `--dns virtual` makes tun2proxy answer
  those itself, so a hostname is not a side channel around the policy. A root
  process can still send a query straight to `192.168.5.3`, past tun0. It gets
  no answer: with Lima's host resolver off that address is qemu's forwarder to
  the host's nameservers, and inside the fence there is no route to them. Every
  verdict the gatekeeper makes, allowed or refused, is logged with the host it
  named.
- **Nothing inspects content.** The gatekeeper decides on the `CONNECT` target
  and then pipes the connection through untouched; it never terminates TLS, so
  it cannot see or alter what travels inside an allowed connection.
- **An allowed name can front for a different one.** Many names sit behind the
  same shared CDN, so a client can open a tunnel to a name the policy allows and
  then, inside it, ask for a different site -- in the TLS handshake's SNI or the
  HTTP `Host` header -- and the gatekeeper never reads inside the tunnel to
  notice the mismatch: it already decided on the name in the `CONNECT`, before
  any of that is visible. That follows from not terminating TLS, which is the
  right call for a proxy that must not itself be able to read what it relays,
  but it means "allow `github.com`" is wider than it looks: names like
  `objects.githubusercontent.com` sit behind shared front ends too.

## What was measured, and where

`src/network/e2e.ts` is the proof, run by hand against a real Lima VM -- not
part of `npm test`. It boots a plain Ubuntu 24.04 cloud image with none of the
base image's own layers (tun2proxy is copied in and started by hand, since this
VM never ran the `tun2proxy()` layer), and checks 17 steps: the sandbox comes up
behind the gatekeeper; `limactl shell` works over Lima's own socket, and still
works once that socket's master is killed, confirmed by `ss -x -p` naming
`control.sock`; tun2proxy routes the guest to the gatekeeper; an allowed host
answers and a denied one is refused, both logged; a raw socket with no proxy
setting configured still goes through the tun and out; a query sent straight to
Lima's resolver address from the guest gets no answer record; the VM survives
the helper being `SIGKILL`ed, stays fenced with no egress, and a new helper
reattaches and restores it; a rewritten policy is applied before `bringUp`
returns; `limactl stop` tears the fence down cleanly; and no socat or
`__net-inside` process is left running for the sandbox, checked before the
script's own cleanup. All 17 passed, run as an unprivileged user in a container,
Lima 2.2.0 under software emulation.

An 18th step came with `network.ports`: it installs socat in the guest with
`apt-get` through the fence (Ubuntu's two archive names allowed for that step
only, since this VM has none of the base's layers), lists a port whose host side
is a listener on the host's loopback, fetches it from the guest's own
`localhost`, and looks for its `allow` line for `host.playpen.internal:<host>`
in `gatekeeper.log`. All 18 pass. By hand, on a sandbox cloned from a base
rebaked with socat: `playpen start` said the host port was at the guest's
`localhost:4321` before it said ready, `curl localhost:4321` in the guest
returned the host's answer, and a second start mapping the same host port to the
guest's port 22 warned that nothing could listen there and carried on.

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
