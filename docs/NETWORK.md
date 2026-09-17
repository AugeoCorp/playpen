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

**Traffic out.** The guest runs `tun2proxy-bin`, a program that creates a tun
device -- a virtual network interface the kernel routes packets to instead of a
real one -- and hands every packet it catches to an HTTP proxy. It is started as
a systemd unit (`tun2proxy()` in `src/image/layers.ts`) with:

```
tun2proxy-bin --proxy http://192.168.5.2:1080 --setup --dns virtual --bypass 192.168.5.0/24
```

`192.168.5.2` is the address Lima's user-mode networking gives the guest for
reaching "the host". `--setup` installs the tun device and takes over the
default route. `--dns virtual` makes tun2proxy answer the guest's DNS lookups
itself with synthetic addresses, so a request still carries the hostname when it
reaches the proxy -- nothing in the guest needs a working resolver, and no name
ever needs to leave it separately. `--bypass 192.168.5.0/24` keeps replies to
qemu's own gateway off the tun; without it the guest's side of the ssh
connection Lima drives it through would go into the tunnel too and die.

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
leaves it alone. If the VM is up but its helper died, `start` reattaches: a new
gatekeeper and relay, no new namespace, since qemu and the inside relays were
never the helper's children to lose.

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
- **`localhost:PORT` in the config** is the one way to reach a service on the
  host machine. The guest cannot ask for it directly: it has to `CONNECT` to the
  literal name `host.playpen.internal`, which the gatekeeper maps to
  `127.0.0.1:PORT` only when a matching `localhost:PORT` entry exists. The port
  is required, so one entry cannot open every service on the host.
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

What has not been run: `playpen start` itself against a baked base image -- the
base's own `tun2proxy()` systemd unit has never been exercised, only the binary
copied in by hand for the e2e run; a host reboot; and any of this on the
maintainer's own machine.

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
  something its public interface exposes, only its internals. It also pulls in
  far more than `proxy-chain` needs to: installing it alone adds tens of
  megabytes of dependencies to a job that is one `CONNECT` decision.
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
- **Publishing chosen guest ports to the host**, now that nothing is forwarded
  by default the way Lima used to forward every guest loopback port.
- **A measured built-in list.** See the numbered item in `docs/PLAN.md`.
