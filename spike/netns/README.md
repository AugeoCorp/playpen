# Option C mechanism -- prototype

`./prototype.sh` builds the fence, the proxy and the two socket-file crossings
described under "Option C" in `docs/NETWORK.md`, then asserts each property the
design claims. Seven checks, all passing on Linux 6.18 as of 2026-09-17.

```
1. the fence is real
  ok    no route out from inside
  ok    and it fails fast rather than hanging
2. the socket file is the only way out
  ok    allowed host reaches the internet
  ok    killing the proxy severs it (fails closed)
3. policy still applies through the relay
  ok    denied host is blocked, not merely unreachable
4. the control path bridges back out
  ok    the stand-in for Lima's ssh port is unreachable from outside
  ok    and reachable once bridged, with no nsenter on our side
```

The first pair is what makes the rest mean anything: nothing reaches the
internet from inside the namespace by any route, so a later success can only
have come through the socket file.

"Fails closed" is the result option A could not give us. Killing mitmproxy
severs egress instead of releasing it, because there is nothing else to fall
back to.

## What it does not prove

**qemu is absent.** The prototype runs its client inside the fence directly,
where the real thing would have the guest reach `192.168.5.2` and qemu translate
that onto the namespace's loopback. That hop is the one part still taken on
faith, along with everything else Lima-shaped: whether qemu owns the ssh
listener, whether hostagent tolerates having no network, whether a VM survives
`stop`/`start` inside the fence.

**The namespace here is made by root**, because `nsenter` wants to be the
creator. `unshare -Urn` as `nobody` was checked separately and works, so the
unprivileged path is available; this script just does not exercise it.

`ip link set lo up` is needed because a fresh namespace has loopback down, and
playpen would shell out to `ip` for it the same way.

## Pieces

- `relay.ts` -- carries connections across the fence in either direction. Two
  modes, one per direction, about forty lines.
- `prototype.sh` -- wiring and assertions.
- `../mitmproxy/allowlist.py` -- the policy, unchanged from the earlier spike
  and unchanged by the move to `socks5` mode.

Needs `mitmdump` on PATH (`uv tool install --python 3.13 mitmproxy`) and
`iproute2`.
