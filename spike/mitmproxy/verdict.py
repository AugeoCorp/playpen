"""Egress policy for mitmproxy: which hosts the guest may reach.

The policy is a JSON file playpen writes, re-read per connection so a change
takes effect without restarting the proxy:

    {"allow": ["anthropic.com", "pypi.org"], "enforce": true}

An empty allow list reaches anything. `enforce: false` records a verdict and
lets the connection through, which is how the domain list gets collected before
there is an allow list worth writing; leaving it out enforces, so a half-written
file cannot quietly stop blocking.

A policy that cannot be read, or that is not an object, is a denial. Losing the
file severs egress rather than releasing it.

PLAYPEN_POLICY  path to that file
"""

import json
import logging
import os

from mitmproxy import http, tcp, tls

POLICY = os.environ.get("PLAYPEN_POLICY", "")

# The SNI is only available in tls_clienthello and the block has to happen in a
# later hook, so the verdict is carried across on the client address.
_verdicts: dict[tuple, str] = {}


def matches(allow: list[str], host: str) -> bool:
    if not allow:
        return True
    name = host.lower().rstrip(".")
    for entry in allow:
        suffix = entry.lower().strip(".")
        if name == suffix or name.endswith("." + suffix):
            return True
    return False


def decide(policy: dict, host: str) -> str:
    if matches(policy.get("allow") or [], host):
        return "allow"
    return "report" if policy.get("enforce") is False else "deny"


def verdict(host: str) -> str:
    try:
        with open(POLICY) as f:
            policy = json.load(f)
    except (OSError, ValueError) as e:
        logging.warning(f"PLAYPEN policy unreadable ({e}), denying {host!r}")
        return "deny"
    if not isinstance(policy, dict):
        logging.warning(f"PLAYPEN policy is not an object, denying {host!r}")
        return "deny"
    return decide(policy, host)


class Verdict:
    def tls_clienthello(self, data: tls.ClientHelloData) -> None:
        sni = data.client_hello.sni or ""
        reply = verdict(sni)
        logging.warning(f"PLAYPEN {reply} sni={sni!r}")
        _verdicts[data.context.client.peername] = reply
        # Allowed traffic is passed through undecrypted. Only a denial is
        # terminated, because answering it is the only way to block a guest
        # that already trusts our certificate.
        data.ignore_connection = reply != "deny"

    def tcp_start(self, flow: tcp.TCPFlow) -> None:
        if _verdicts.get(flow.client_conn.peername) == "deny" and flow.killable:
            logging.warning(f"PLAYPEN kill tcp {flow.server_conn.address}")
            flow.kill()

    def request(self, flow: http.HTTPFlow) -> None:
        if _verdicts.get(flow.client_conn.peername) == "deny":
            logging.warning(f"PLAYPEN block http {flow.request.pretty_host}")
            flow.response = http.Response.make(
                403, b"blocked by playpen policy\n", {"Content-Type": "text/plain"}
            )


addons = [Verdict()]
