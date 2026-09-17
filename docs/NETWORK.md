# Network containment

Design note for the egress work `spec.md` defers. That section holds the prior
reasoning (guest-side nftables as a guardrail; host-side nftables matched on
`socket cgroupv2` as the real boundary) and is still accurate. This adds what
Lima actually provides, two userspace routes that need no host firewall rules,
and the order to build in.

Checked against Lima 2.2.0 docs on 2026-09-16. The mitmproxy claims were
measured on 2026-09-17; see `spike/mitmproxy/`.

## Goals, in the order they pay off

1. **See** what the agent reaches. There is no allowlist worth writing before
   the list is measured.
2. **Restrict** it to declared destinations.
3. **Keep credentials off the guest**, by swapping a placeholder for the real
   secret in flight.

Each is a change to the same component, so the first one built decides the rest.

## What Lima gives us: nothing for egress

| Knob                                   | Controls                                        |
| -------------------------------------- | ----------------------------------------------- |
| `portForwards` + `ignore: true`        | Which guest ports reach the host. Inbound only. |
| `hostResolver.hosts`                   | Static name → IP. DNS steering, not a boundary. |
| `hostResolver.enabled: false` + `dns:` | Which nameservers the guest is handed.          |
| `networks:`                            | Adds reachability. Never removes it.            |

No firewall, no policy, no way to disable networking, and no `qemuArgs`
(confirming [#932](https://github.com/lima-vm/lima/issues/932), which `spec.md`
already cites). `limactl network create` takes `--gateway` and nothing else; a
network in `networks.yaml` has `mode`, `interface`, `gateway`, `dhcpEnd`,
`netmask`.

[PR #4326](https://github.com/lima-vm/lima/pull/4326) would add
`limactl network create --policy` — protocol, port, CIDR and domain rules with
DNS snooping, enforced host-side in gvproxy, written for coding agents. Open,
moved off the v2.1.0 milestone, and maintainers are steering it toward a plugin
architecture. gvproxy itself exposes no filtering, no pcap and no upstream
proxy, which is why that PR reaches into its internals by reflection.

Two things the defaults do today, both worth fixing regardless:

- Lima appends a fallback rule forwarding every guest `127.0.0.1` port to the
  host. Anything the agent binds is published.
- `192.168.5.2` is the host's loopback. Every sandbox can reach host-local
  services -- a database, an inference server -- with no credentials.

## The rule

The agent has passwordless sudo in the guest. Anything it can turn off is a
guardrail, not a boundary: proxy env vars are advisory, and guest nftables is
one `nft flush ruleset` away from gone. Both are still worth having for
measurement, and both must be named for what they are, the way `masked` is
documented as not hidden.

A boundary has to sit where guest root cannot reach: in the host process that
carries the traffic, or in a namespace around it.

## Option A -- mitmproxy local capture

`mitmproxy --mode local:<pid>` redirects one host process's outbound traffic
with eBPF. Under Lima's default user-mode network there is no gvproxy: qemu's
own slirp opens the connections, so qemu is the process. All guest egress leaves
through it, the redirect is enforced by the host kernel, and guest root cannot
reach around it.

- Linux support is **egress only**, needs kernel 6.8+, and spawns a privileged
  helper with `sudo` to load the eBPF program.
- Process names are capped at 16 characters, so `qemu-system-x86_64` will not
  match by name. Target the pid, which suits one-VM-per-sandbox.
- Log, block and header injection are all addon hooks. Domain decisions can be
  made in `tls_clienthello` from the SNI, before any decryption.
- mitmproxy generates a CA at `~/.mitmproxy/`. The public cert goes in the base
  image; Node ignores the system store, so Claude Code needs
  `NODE_EXTRA_CA_CERTS`. **The private key never enters the guest** -- not in
  the mount, not in the `~/.claude` sync. A guest holding it can impersonate
  anything to us, which is worse than the hole being closed.

### What the spike measured

`spike/mitmproxy/` runs this against a plain `curl` and records the mechanism in
full. The load-bearing results:

**It fails open.** Kill the mitmproxy and traffic flows unfiltered within
seconds. That settles the question this section used to leave open: Option A is
observation. It is not a boundary, and no amount of addon work makes it one.

**A deny has to be an explicit block.** `ignore_connection` is
allow-and-passthrough. Once the guest trusts our CA a denied connection
completes to mitmproxy and has to be answered -- 403 for HTTP, `flow.kill()` for
raw TCP. The SNI verdict itself does land before decryption, as assumed, and an
allowed host is never decrypted.

**The privileged helper outlives its parent**, holding a `tun` device and its
routing rules, so something has to reap it. The leases already know when the
last session went away.

**Pid targeting does not follow children.** `set_intercept()` retargets a
running proxy, so a VM restart costs a new spec rather than a new proxy. The
originating pid reaches the Rust stream but not `mitmproxy.connection`, so one
proxy cannot tell two sandboxes apart until that is patched through.

Still unmeasured: non-HTTP TCP, and everything qemu-specific -- whether Lima's
hostagent keeps qemu in the pid we targeted, and whether that pid survives a
`stop`/`start`.

## Option B -- unprivileged network namespace

Unprivileged user namespaces (`bwrap --unshare-net`, `unshare -Urn`; enabled by
default on Fedora-derived hosts) put the VM in a network namespace with only
loopback, no root required. Two ways to give it an exit:

- **B1, unix socket relay.** No network in the namespace at all. The proxy
  relays out over a unix socket, which crosses the boundary as a filesystem
  object. Complete containment, and the host-loopback hole closes with it
  because there is no host loopback to reach.
- **B2, `slirp4netns --disable-host-loopback` or `pasta`.** Real egress through
  a userspace stack we launched, minus host services. No policy of its own, so
  traffic still has to be pointed at the proxy.

Cost, in both: Lima talks to the guest over `127.0.0.1:<ssh port>`, which is a
different loopback once namespaced. `limactl` and its SSH have to run inside,
which means a per-sandbox holder process to join for every `shell`, `run` and
`claude`, or a relay bridging SSH back out. That puts playpen underneath Lima's
lifecycle rather than on top of it.

## Comparison

|                             | Guest nftables | A: local capture   | B: namespace      |
| --------------------------- | -------------- | ------------------ | ----------------- |
| Root needed                 | no             | NOPASSWD for eBPF  | no                |
| Survives hostile guest root | no             | yes                | yes               |
| Survives its own death      | n/a            | no -- fails open   | yes               |
| Covers non-HTTP             | yes            | unmeasured         | yes               |
| Covers DNS                  | yes            | yes, but see below | B1 yes, B2 partly |
| Header injection            | no             | yes                | via the proxy     |
| Effort                      | hours          | hours              | days              |

The proxy captures DNS from the process it targets -- measured. It will not see
guest lookups while `hostResolver` answers them inside hostagent, which is a
Lima question, not a mitmproxy one.

## Order of work

1. A against a real VM, log-only, everything tunneled, nothing decrypted.
   Confirm the agent still works, collect the domain list, and settle the two
   qemu questions the spike could not reach.
2. Policy surface in `playpen.config.ts` (`allow: [...]`), defaulting to
   allow-all, with an `allow`/`deny` verdict in the log from the first commit so
   enforcement is a config change rather than a new code path.
3. Lifecycle on the leases: the proxy starts with the first session and dies
   with the last, like the VM. Reaping the leaked redirector belongs here.
4. Enforce, underneath A rather than with it. A fails open, so the boundary is a
   host-side default-deny on the qemu cgroup that permits only the redirected
   path -- `spec.md`'s own answer, and now cheaper than option B, which costs
   days and puts playpen underneath Lima's lifecycle. Write the two together:
   the nftables rule has to allow what the redirect needs and nothing else.
5. Injection last, per host, only where a scoped short-lived token is not the
   better answer. See the credential notes in `spec.md`.

## What none of this solves

- **DNS.** Lima's host resolver answers guest lookups in the hostagent process,
  so labels can carry data out without touching the proxy. Setting
  `hostResolver.enabled: false` and pointing `dns:` at a resolver moves lookups
  into qemu's egress, where the proxy does see them -- visibility, not a
  boundary, since guest root can rewrite `resolv.conf`.
- **Allowed destinations.** As `spec.md` already says: allow github.com and an
  agent can push a branch full of secrets. This blocks unknown destinations; it
  is not a data-loss control.
- **The mount.** It is the sharing channel, by design.

## Option C -- seal qemu, relay out through a socket file

Where this landed, and it replaces step 4 of the order of work above: the
default-deny on a cgroup wanted root, and the point of this is to need none.

Options A and B both treat the proxy as something bolted onto a working network.
Fence qemu instead, give it no network at all, and the proxy stops being a
detour off a road that still exists. It becomes the only road.

### The shape

An unprivileged network namespace (`unshare -Urn`) holds qemu and hostagent,
with nothing in it but loopback. mitmproxy runs outside, where the real network
is. The two sides meet at a socket file, which crosses the fence because the
filesystem was never unshared -- only the network was.

```
╭─ guest ── its own kernel, only reachable through qemu ───────────╮
│    agent ──TCP──► 192.168.5.2:1080             sshd :22          │
╰───────────────────────│─────────────────────────────▲────────────╯
  ═══════════════════════════ VM boundary ══════════════════════════
╭─ host, inside the fence ── no route anywhere ────────────────────╮
│                       ▼                             │            │
│                     qemu ───────────────────────────╯            │
│                       │            hostagent                     │
│             127.0.0.1:1080               127.0.0.1:<ssh port>    │
│                     relay                      relay             │
╰───────────────────────│─────────────────────────────▲────────────╯
           socket file  │                             │  socket file
╭─ host, outside the fence ────────────────────────────────────────╮
│                       ▼                             │            │
│                    bridge                        bridge          │
│                       │                             ▲            │
│                   mitmproxy                   limactl shell      │
│                       │                                          │
│                    internet                                      │
╰──────────────────────────────────────────────────────────────────╯
```

The left column is the agent getting out, the right is us getting in. Same
mechanism, opposite directions.

**The host-loopback hole becomes the door.** `192.168.5.2` is how the guest
reaches our loopback, which this document lists above as a problem. Fenced, that
address resolves to the namespace's loopback, where the only thing listening is
our relay. Nothing else is on it, so nothing else is reachable.

**Guest root has nothing to undo.** It can rewrite `resolv.conf`, flush
firewalls and reconfigure its interface, and none of it matters: the guest
cannot make a syscall on this machine. Only qemu can, and qemu is fenced. That
also means the guest's proxy settings need no defending. Deleting them costs it
everything and buys it nothing.

**The control path bridges out the same way**, so `limactl shell` and friends
run from outside with no `nsenter` wrapper. That was the expensive part of
option B and most of it goes away.

### What it drops

The eBPF redirector, and with it the passwordless sudo, the leaked privileged
helper, and the fail-open that made option A observation only. mitmproxy keeps
its job as the policy and the log; it stops being asked to be the boundary.

### Configuration

mitmproxy runs in `socks5` mode with hostnames passed rather than addresses, so
name lookups land on our side and the guest needs no resolver at all. That is
also how the DNS hole above closes: `hostResolver` starves inside the fence, and
should be turned off explicitly rather than left waiting on lookups that can
never finish. The guest needs one setting,
`ALL_PROXY=socks5h://192.168.5.2:1080`.

`spike/mitmproxy/allowlist.py` works unchanged in `socks5` mode -- measured.
Allow passes through undecrypted, deny answers 403, log-only records the verdict
and passes.

### Traps

- **Abstract sockets do not cross the fence.** They are scoped to the network
  namespace. A path socket connects through it; an abstract one gets connection
  refused, with nothing in the error to say why. Measured both ways.
- **A socket file outlives its process**, so a stale one refuses connections and
  blocks a rebind. Unlink before binding.
- **The guest's network will look healthy.** Interface up, route present, lease
  held, every connection failing the instant it tries to leave. Worth saying so
  in `doctor`, because it reads as a bug.
- **mitmproxy listens on TCP only**, so the outside end of each socket file is a
  small bridge rather than mitmproxy itself.

### What is proven

`spike/netns/` asserts the properties above twice: once with no VM
(`prototype.sh`, 7 checks) and once with a real Lima 2.2.0 VM inside the fence
(`lima-fenced.sh`, 13 checks). All pass, and the guest pulled 46MB through the
chain, so this is traffic rather than a handshake.

The two assumptions this rested on were confirmed against the real thing:

- **qemu owns the ssh listener.** Lima builds
  `-netdev user,...,hostfwd=tcp:<addr>:<port>-:22`, and `ss` names
  `qemu-system-x86` as the process holding it.
- **`192.168.5.2` reaches the fence's own loopback.** The guest fetched a page
  from a server bound to `127.0.0.1` inside the namespace. The hole this
  document lists above really does become the door.

Two things came out better or worse than drawn. **Bubblewrap is the fence**, not
`unshare`: `unshare -Urn` makes you root inside and `limactl` refuses to run as
root, while `--map-current-user` keeps your uid but loses the capability to
bring loopback up. `bwrap --unshare-net` gets your own uid, loopback up and no
route out, unprivileged. And **the control path may need no bridge at all**:
Lima leaves an ssh control socket in `~/.lima/<instance>/`, which is a file, so
`limactl shell` reached the guest from outside before anything was bridged. The
bridge still earns its place for when that master connection is gone.

One more trap, found the hard way: Lima copies the host's proxy environment into
the guest, `no_proxy` included, and a `no_proxy` entry turns the guest's proxy
setting off for exactly those hosts. In a sealed box that makes them unreachable
rather than direct, and the guest reports `Could not resolve host`.

Untested still: the VM ran under software emulation, so nothing here speaks to
timing, and `stop`/`start` of a fenced instance across a restart of the fence
has not been exercised.

This holds only while Lima's default user-mode networking translates on the
guest's behalf. Give the VM a real network card and the guest gets its own path
to the wire, the translation stops, and the fence stops meaning anything.

## Option C, revised

What changed after the measurements above, and why. The shape is unchanged; the
parts are different.

**socat replaces the hand-written relay.** It does the same job in a tool that
has been carrying connections between sockets for two decades. Four invocations,
two per direction:

```
outside  socat UNIX-LISTEN:egress.sock,fork           TCP:127.0.0.1:1081
inside   socat TCP-LISTEN:1080,fork,bind=127.0.0.1    UNIX-CONNECT:egress.sock
inside   socat UNIX-LISTEN:control.sock,fork          TCP:127.0.0.1:<ssh>
outside  socat TCP-LISTEN:<ssh>,fork,bind=127.0.0.1   UNIX-CONNECT:control.sock
```

**The control bridge stays**, even though Lima's own ssh control socket turned
out to cross the fence. That socket only works while hostagent's master
connection is alive; when it drops, ssh falls back to opening its own
connection, which needs a port only reachable inside the fence. The free path
would therefore fail exactly when something else has already gone wrong.

**`hostResolver` is off.** Name lookups happen at the proxy, so the guest needs
no resolver, and the exfiltration channel this document lists under "what none
of this solves" closes with it.

**The policy is TypeScript behind a bridge.** mitmproxy loads Python addons and
nothing else, so `spike/mitmproxy/verdict.py` stays Python. It is reduced to
asking a question over a unix socket and applying the answer, with no policy in
it. `spike/policy/` decides, in the language the rest of playpen is written in,
and is unit-tested without a proxy anywhere. The bridge fails closed: no answer
means deny.

### The guest side is still an open choice

Two ways to point the guest at the relay, and they fail differently.

**An environment variable**, `ALL_PROXY=socks5h://192.168.5.2:1080`. What was
measured. Nothing to install, and `socks5h` hands hostnames to the proxy so the
guest needs no DNS at all. But a program has to read the variable and speak
SOCKS, and many do not. The sandbox this work was done in is the evidence:
making the same trick work there took `HTTPS_PROXY`, `npm_config_https_proxy`,
`YARN_HTTPS_PROXY`, `GLOBAL_AGENT_HTTPS_PROXY`, `ELECTRON_GET_USE_PROXY`,
`CLOUDSDK_PROXY_*` and a `JAVA_TOOL_OPTIONS` line, one per ecosystem, and raw
sockets still escape it. Check early whether Claude Code's HTTP client honours
proxy variables, because if it does not, the variable approach fails at the one
thing the sandbox exists to run.

**A route**, `tun2socks` on a tun device the guest's default route points at.
Nothing in the guest needs to know, which covers raw sockets and proxy-ignorant
tools alike, and no `no_proxy` can route around a route. Costs a layer in the
base image, and DNS becomes ours to handle rather than the proxy's. Untested.

So: proxy-aware programs and no DNS problem, or any program at all and a DNS
problem to solve.
