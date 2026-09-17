"""SNI allowlist for mitmproxy local mode.

The verdict comes from the ClientHello, so it is made before any decryption and
without an upstream connection. Allowed traffic is never decrypted; only a
denied connection is terminated, because answering it is the only way to block
a guest that already trusts our CA.

PLAYPEN_ALLOW      comma-separated domain suffixes; empty allows everything
PLAYPEN_ENFORCE=1  block denied flows; otherwise record the verdict only
"""

import logging
import os

from mitmproxy import http, tcp, tls

ALLOW = set(filter(None, os.environ.get("PLAYPEN_ALLOW", "").split(",")))
ENFORCE = os.environ.get("PLAYPEN_ENFORCE") == "1"

# The SNI is only available in tls_clienthello, and the block has to happen in
# a later hook, so the verdict is carried across on the client address.
_verdicts: dict[tuple, str] = {}


def verdict(host: str) -> str:
    if not ALLOW:
        return "allow"
    return "allow" if any(host == a or host.endswith("." + a) for a in ALLOW) else "deny"


class Allowlist:
    def tls_clienthello(self, data: tls.ClientHelloData) -> None:
        sni = data.client_hello.sni or ""
        v = verdict(sni)
        logging.warning(f"PLAYPEN {v} sni={sni!r}")
        _verdicts[data.context.client.peername] = v
        data.ignore_connection = v == "allow" or not ENFORCE

    def tcp_start(self, flow: tcp.TCPFlow) -> None:
        if _verdicts.get(flow.client_conn.peername) == "deny" and ENFORCE and flow.killable:
            logging.warning(f"PLAYPEN kill tcp {flow.server_conn.address}")
            flow.kill()

    def request(self, flow: http.HTTPFlow) -> None:
        if _verdicts.get(flow.client_conn.peername) == "deny" and ENFORCE:
            logging.warning(f"PLAYPEN block http {flow.request.pretty_host}")
            flow.response = http.Response.make(
                403, b"blocked by playpen allowlist\n", {"Content-Type": "text/plain"}
            )


addons = [Allowlist()]
