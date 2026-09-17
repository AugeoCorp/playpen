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

**Pid targeting does not follow children**, and flows carry no originating pid,
so per-sandbox policy means one mitmproxy per sandbox. `set_intercept()`
retargets a running proxy, so a VM restart costs a new spec rather than a new
proxy.

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
