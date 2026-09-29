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

**Secrets.** A `network.secrets` entry names a variable in the environment of
the `playpen start` that boots the sandbox, and the hosts it may be used on. The
value goes one way only: into the helper, which puts it into the `Authorization`
header of requests to those hosts (see "Secrets" below) and nowhere else. A host
that echoes `Authorization` back in its answer would return the value to the
guest, so grant a secret only to hosts you would send it to anyway.
`playpen start` reads it and refuses to boot if any named variable is unset or
empty (listing every one, before the VM is touched). It spawns the helper with a
stdin pipe and writes one JSON document to it,
`{ "secrets": [{ "env", "value" }] }`, followed by end-of-stream; a project with
no secrets sends `{ "secrets": [] }`, so the helper never waits on a stdin that
is not coming. A name that two entries share is sent once. The helper reads the
document to the end before it serves anything and keeps the result in memory. It
logs a count and names (`holding 2 secrets: GH_TOKEN, NPM_TOKEN`) and never a
value. The value is not in argv, not in a file, and not in the helper's
environment: the helper gets the parent's environment without every variable the
policy's `secrets` name, whether or not a value was handed over, so a `GH_TOKEN`
exported in your shell reaches neither the helper nor the bwrap, limactl and
qemu below it. The boot that saves a stopped sandbox's history before it is
deleted allows nothing, but its policy keeps the grants from the sandbox's last
policy.json for the same reason. The hosts are not in the document: policy.json
carries `env` and `hosts` and is the one place they are kept, and it is re-read
on reload. helper.json carries the names the helper holds, so a later `start`
can see what the running helper lacks.

What the guest sees is a placeholder: `playpen-secret-` and the variable name in
lower case with dashes, so `GH_TOKEN` is `playpen-secret-gh-token`. It is fixed
for the name and has no random part, because a placeholder is not a secret and
nothing needs to store it: a guest process that outlives a helper, a token saved
to `.npmrc`, and a reattach after the helper died all keep a placeholder that
the next `start` writes the same way, and that an injector can recognise from
the name alone. `playpen start` writes `/etc/profile.d/playpen-secrets.sh` in
the guest, one `export GH_TOKEN='…'` line per secret the running helper holds,
after the masks are applied, so a login shell has the variable set to it. With
none the file is removed, so one dropped from the config disappears from the
guest.

The helper takes its values at spawn and can take no more: once it is running
its stdin is closed. Only a `start` that spawns a helper needs the variables: a
new sandbox, a stopped one, a rebuild, or a reattach after the helper died. A
`shell` or `run` into a sandbox whose helper is live does not, and a change to
`secrets` on a sandbox that is already up does what it can:

- A secret dropped from the config leaves policy.json on the next `start`, and
  its line leaves the guest's profile. The helper keeps the value in memory
  until it exits.
- A secret added to the config is named in policy.json but not held.
  `playpen start` says
  `secret GH_TOKEN added to the config takes effect after: playpen stop && playpen start`
  and leaves it out of the guest's profile.
- A secret already held keeps the value it was started with. A changed value in
  your environment waits for the same stop and start.

## Lifecycle

`playpen start` writes the merged policy (the built-in list plus the project's
`network.allow`, a `localhost:<host>` for each of its `network.ports`, every
host named by `network.secrets`, and the ports and secrets themselves) to disk,
then spawns the helper process detached so it outlives the command that started
it, handing it any secrets over stdin (see "Secrets" above). The helper starts
the gatekeeper and the two relays, brings the VM up inside a fresh `bwrap`
namespace, and waits for the guest to answer before returning -- streaming its
own log to the terminal in the meantime. If a VM is already running and fenced
with a live helper, `start` leaves the VM alone but still writes the policy, and
says so when the file changed. If the VM is up but its helper died, `start`
reattaches: a new gatekeeper and relay, no new namespace, since qemu and the
inside relays were never the helper's children to lose.

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

## Secrets

The guest holds a placeholder for each secret (see "Secrets" under "The shape"
for how it gets there); the helper puts the real value in on the host side, in
the `Authorization` header of HTTPS requests to the hosts the secret names.

**What is intercepted.** A `CONNECT` the policy allows, to port 443 of a host a
`network.secrets` entry names, for a variable the helper holds. The host must be
the one the entry names exactly: `api.github.com` does not cover
`uploads.api.github.com`, though the allow entry it implies does. `secrets` is
read from the current policy on each `CONNECT`, like `allow`, so a reload adds
or drops interception for new tunnels without a restart; a tunnel already open
keeps what it started with. A secret a reload adds is intercepted for only if
the helper already holds its variable, since values arrive only at spawn; one it
does not hold is piped, placeholder and all, with a `note` line saying so (see
below). Every other `CONNECT` -- another host, another port on the same host --
and every plain-HTTP request is piped as before.

**What happens in the tunnel.** The gatekeeper answers the `CONNECT` itself and
hands the tunnel to a server made for that one host
(`src/network/intercept.ts`), which terminates TLS, offering HTTP/1.1 only. A
TLS server name other than the host the `CONNECT` named is refused. So, with a
421 and a `deny` line, is a request whose `Host` header names another site, and
one whose request line is anything but a path (or `*` for `OPTIONS`), or a path
starting `//`, which a URL parser reads as naming a host: behind a shared front
end, `Host` or a full URL in the request line (`GET https://other.example/`,
which overrides `Host`) can decide which site gets the request, and with it the
value. A `TRACE` request is refused with a 405 and a `deny` line naming the
method, before the host is dialed: a TRACE answer echoes the request back, the
value in `Authorization` included. The upstream sees exactly one `Host`, the
approved host, whatever the guest sent, and never the guest's
`X-Forwarded-Host`, `Forwarded`, `X-Original-URL`, `X-Rewrite-URL`, `X-Host`,
`X-HTTP-Host-Override` or `X-Forwarded-Server`, which some front ends route by;
hop-by-hop headers (`Connection`, `Keep-Alive`, `Proxy-Authorization`,
`Proxy-Connection`, `TE`, `Trailer`, and `Upgrade` outside an upgrade) are
dropped too, from the request and from the host's answer. Every other header
goes on as sent. Each request's headers are read, the placeholder is replaced
(`rewriteHeaders` in `src/network/inject.ts`), and the request goes on over a
new TLS connection to the host the `CONNECT` named, at port 443, verified
against the certificates Node carries. That connection is resolved and dialed
through the same lookup a piped tunnel would use, so every rule under "Policy"
holds for it: a secret's host whose name resolves onto this machine is refused
the same way. Bodies, both ways, are streamed through unread; a host that hangs
up partway through its answer cuts the guest's response off the same way, with
an `error` line. One tunnel carries as many kept-alive requests as the client
sends on it, and a WebSocket upgrade gets the same refusals and header rewrite
before the two connections are joined.

**Where the placeholder is replaced.** In the `Authorization` request header and
nowhere else: wherever it appears verbatim (`token X`, `Bearer X`), and inside
`Basic` credentials, which are decoded, swapped and encoded again, since that is
how git sends a token. gh, git, curl `-u` and npm all send a token there. Any
other header goes out as the guest sent it, placeholder included: a host that
echoes a request header back (api.github.com quotes `X-GitHub-Api-Version` in an
error) would otherwise hand the value to the guest. The same holds for
`Authorization` itself, which this cannot close beyond refusing `TRACE`: a host
that echoes it returns the value to the guest, so grant a secret only to hosts
you would send it to anyway. Only the secrets whose entry names this host are
swapped; a placeholder for any other goes out as it is.

**The certificates.** A helper holding at least one secret reads the CA once at
start (`readCa()`), and fails to start if there is none: a new CA made then
would be one the running guest does not trust, and every intercepted handshake
would fail. It makes one RSA key for its life and, for each host on first use, a
certificate signed by the CA (`src/network/leaf.ts`): the host as its common
name and its one DNS name, not a CA, server authentication only, valid for seven
days, and naming the CA's key identifier, which Python's strict verification
requires. One within a day of its end is minted again, since a helper lives as
long as its VM. The guest accepts it because it trusts the CA (below).

**What the log shows.** One `inject` line in `gatekeeper.log` for each header
and variable a value went into, written once the connection to the host is up,
so a request whose dial is refused or whose host fails verification logs none.
It names the host, the port, the header and the variable:
`{"verdict":"inject","host":"api.github.com","port":443,"header":"authorization","env":"GH_TOKEN",…}`.
A wrong server name, `Host`, request target or method is a `deny` line saying
what was asked for. A client that sends no server name is refused in the
handshake too, but that shows up as an `error` line (OpenSSL's "no suitable
signature algorithm"), since there was no name to check. Any other TLS or
upstream failure is an `error` line with the message alone. A `CONNECT` to port
443 of a host that names a secret the helper does not hold gets a `note` line,
so an audit shows why a request went out with the placeholder:
`secret GH_TOKEN is named for this host but this helper does not hold it; piped`.
No line carries a value, and nothing logs a body.

**What it does not do.** HTTP/2: only `http/1.1` is offered, which gh, git, curl
and Node fall back to. A client that sends no server name is refused, as above.
Plain HTTP to a secret's host is piped, placeholder and all, since there is no
TLS to terminate. Nothing in a body, a URL or a query string is replaced, so a
client that sends its token that way sends the placeholder. A value changed in
your environment reaches the helper only on `playpen stop && playpen start`. The
upstream is checked against Node's own certificate list, plus any
`NODE_EXTRA_CA_CERTS` in the environment `playpen start` ran with, not the
host's system store.

For the guest to accept the interceptor's certificates, each install has one
certificate authority (`src/network/ca.ts`) in the `ca/` directory under the
data directory: its key is mode 0600, is refused if it is readable by group or
others, and never leaves the host. Its certificate is public and is installed
into the guest's trust store when the base image is baked (the `caTrust()`
layer). curl, git and Go programs such as gh read that store. Node reads no
system store, Python's requests carries its own bundle, and uv and other tools
with their own TLS stack read `SSL_CERT_FILE`, so `NODE_EXTRA_CA_CERTS`,
`REQUESTS_CA_BUNDLE` and `SSL_CERT_FILE` are set through the image's `env`,
which Lima writes to `/etc/environment` for every session, sudo included. The
certificate is part of the image hash, so a new CA rebakes the base. The CA is
created in a staging directory and published with one rename, so two first runs
at once share one CA. It has no name constraints: the hosts differ per project
and change over time, while the CA is one per install.

## What it does not contain

- **An allowed destination is still a way out.** Allow `github.com` and an agent
  can push a branch full of secrets to a repo it controls. The fence stops
  unknown destinations; it says nothing about what an agent does with the ones
  it is allowed to reach.
- **The project mount is the sharing channel, by design.** It was never part of
  what the fence closes.
- **DNS lookups happen at the gatekeeper**, not in the guest, for every program
  that uses the guest's own resolver: `--dns virtual` makes tun2proxy answer
  those itself, so a hostname is not a side channel around the policy. A root
  process can still send a query straight to `192.168.5.3`, past tun0. It gets
  no answer: with Lima's host resolver off that address is qemu's forwarder to
  the host's nameservers, and inside the fence there is no route to them. Every
  verdict the gatekeeper makes, allowed or refused, is logged with the host it
  named.
- **Nothing inspects content, except request headers bound for a secret's
  host.** The gatekeeper decides on the `CONNECT` target and then pipes the
  connection through untouched; it never terminates TLS for any other host, so
  it cannot see or alter what travels inside those connections. For a secret's
  host it reads the request line and headers: it rewrites `Authorization`,
  replaces `Host`, drops the headers listed there, and refuses the requests
  listed there (see "Secrets").
- **An allowed name can front for a different one.** Many names sit behind the
  same shared CDN, so a client can open a tunnel to a name the policy allows and
  then, inside it, ask for a different site -- in the TLS handshake's SNI or the
  HTTP `Host` header -- and the gatekeeper never reads inside the tunnel to
  notice the mismatch: it already decided on the name in the `CONNECT`, before
  any of that is visible. That follows from not terminating TLS, which is the
  right call for a proxy that must not itself be able to read what it relays,
  but it means "allow `github.com`" is wider than it looks: names like
  `objects.githubusercontent.com` sit behind shared front ends too. A secret's
  host is the exception: there the server name and `Host` must both be the host
  the `CONNECT` named, the request line must be a path not starting `//`, and
  the upstream gets one `Host` naming that host and none of the routing headers
  listed under "Secrets". That closes the ways of naming another site that this
  code knows of; a front end that routes on something else still could.

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

The interceptor was driven by hand with curl 8.5 (token, `-u` Basic, a 3 MB
chunked upload, two URLs over one connection, a mismatched server name),
`openssl s_client`, and Python 3.11's `ssl` with `VERIFY_X509_STRICT`, through
the real gatekeeper to a local upstream. That run predates the request guards:
the `Host`, request target and method refusals and the routing headers dropped
under "Secrets" were not driven by hand, only by
`src/network/intercept.test.ts`.

On a VM (no KVM), with every guard in place, a sandbox holding a made-up value
for `api.github.com`: from the guest, curl with `Authorization: token`, curl
`-u` and Node `fetch` each reached GitHub and got its `401 Bad credentials`,
with one `inject` line each; `TRACE` got a 405 and a `deny` line; the value was
in neither log and nowhere under the data directory. GitHub accepting a real
token has not been shown.

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
- **mockttp as the interceptor.** Measured in a spike against the per-tunnel
  `https.Server` now used: it adds about 190 packages, one with a native build
  step, and 46.6 MB of `node_modules` against 3.3 MB for node-forge; and handing
  it a tunnel takes either a private field or a second proxy chained behind the
  gatekeeper.
- **`bwrap --unshare-pid`.** Isolating the process namespace too, not just the
  network one, sounds like it should make the fence tidier. Lima instead reports
  a perfectly healthy instance as `Broken`, so the fence uses `--unshare-net`
  alone and accepts that qemu and the hostagent, not the helper, are what keep
  the namespace alive.

## Later

- **Publishing chosen guest ports to the host.** Lima still forwards every guest
  loopback port, but inside the fence, where nothing on the host can reach them;
  a dev server in the guest no longer shows up on the host's `localhost`.
- **A measured built-in list.** See the numbered item in `docs/PLAN.md`.
