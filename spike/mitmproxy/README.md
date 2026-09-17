# mitmproxy local mode -- spike

Answers the questions `docs/NETWORK.md` left open under "Option A". Run
`./probe.sh` to reproduce; `allowlist.py` is the addon it drives, and is the
shape the real policy surface would take.

Measured 2026-09-17 on Linux 6.18, mitmproxy 12.2.3, mitmproxy_linux 0.12.11,
against a plain `curl`. **Not** against qemu -- this box has no Lima, so every
result below is about the mechanism, and the qemu-specific rows in
`docs/NETWORK.md` still need a run on the Bazzite workstation.

## What it actually is

`mitmproxy-linux-redirector`, a separate binary beside `mitmdump`, is spawned as
`sudo --non-interactive --preserve-env <redirector> <tmpdir>`. It attaches an
eBPF `cgroup/sock_create` program at the **cgroup v2 root**, so the hook is
system-wide and the process filter runs inside the program. Matching sockets are
steered by policy routing onto a `tun` device that mitmproxy reads.

Consequences that fall straight out of that:

- `/sys/fs/cgroup` must be cgroup2. Fedora and Bazzite are, so this is only a
  problem in containers that still mount v1.
- IPv6 policy routing failing is a warning, not an error. It came up on a host
  without IPv6 and the redirector carried on with v4 only.
- The elevation is `--non-interactive`, so it fails rather than prompting.
  Unattended `playpen run` needs a NOPASSWD sudoers entry for that one binary.

## Findings

**It fails open.** `SIGKILL` the mitmproxy and traffic flows unfiltered within
seconds. Measured twice. This is the question step 4 of the plan turns on, and
it answers it: Option A on its own is observation, never enforcement.

**The privileged helper leaks.** After the parent dies the redirector process
stays up and keeps `tun0` and its routing rules -- still alive 30s later, across
both `SIGTERM` and `SIGKILL`. It stops redirecting, so it is inert litter rather
than a hazard, but something has to reap it. Leases already know when the last
session went away.

**Targeting is a comma-separated list of names or pids**, and `!name` parses as
a negation. `local:curl,python3` intercepted both.

**Pid targeting does not follow children.** Targeting a shell's pid and running
`curl` from it caught nothing. Fine for qemu, which is one process, but it means
the spec has to be updated when a VM restarts and its pid changes.
`LocalRedirector.set_intercept()` takes a new spec at runtime, so that needs no
proxy restart.

**The originating pid exists but is not wired through.** The Rust stream carries
it -- `Stream.get_extra_info("pid")` -- and `mitmproxy.connection` drops it, so
an addon cannot see which qemu a flow came from without a patch. Until someone
writes that patch, per-sandbox policy means one mitmproxy per sandbox. It is a
small patch, and plausibly one upstream would take.

**DNS from an intercepted process is captured.** The proxy logged
`DNS QUERY (A) …` and answered it. The `Covers DNS: no` row in `docs/NETWORK.md`
was wrong about the mechanism; what remains true is the Lima part, that
`hostResolver` answers guest lookups inside hostagent and so never reaches a
proxy watching qemu.

**The SNI verdict works before decryption.** `tls_clienthello` carries the
ClientHello, and `ignore_connection` passes the connection through untouched.
With `connection_strategy=lazy` the decision lands before any upstream
connection. An allowed host is never decrypted.

**A deny has to be an explicit block.** Once the guest trusts our CA a denied
connection completes to mitmproxy and needs answering -- 403 for HTTP,
`flow.kill()` for raw TCP. Relying on the TLS handshake to fail only works while
the CA is absent, which is exactly the state the plan removes.
`ignore_connection` is allow-and-passthrough; it is not a block.

**Packaging.** Linux local mode ships as a separate `mitmproxy-linux` wheel and
needs Python >= 3.12. mitmproxy 11 has no Linux redirector at all -- its binary
still carries the string `OS proxy mode is only available on Windows and macOS`.
`uv tool install mitmproxy` on a 3.11 default silently lands there, so pin the
interpreter: `uv tool install --python 3.13 mitmproxy`.

## Still unanswered

- **Non-HTTP TCP.** Untested. Raw TCP could not leave this box with or without
  the proxy, so the one result gathered proves nothing. Needs the real host.
- **qemu.** Whether Lima's hostagent keeps qemu in the pid we targeted, and
  whether one-VM-per-sandbox holds that pid stable across a `stop`/`start`.
- **Interaction with nftables.** The redirect is socket marks plus policy
  routing. A host-side default-deny on the qemu cgroup has to be written so it
  permits the redirected path and nothing else; the two mechanisms have not been
  run together.

## Running it in a container

`probe.sh` assumes cgroup2 at `/sys/fs/cgroup`. Where it is still v1, run under
a private mount namespace:

```
unshare -m bash -c 'mount --make-rprivate /; mount -t cgroup2 none /sys/fs/cgroup; ./probe.sh'
```
