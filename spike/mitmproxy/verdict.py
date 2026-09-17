"""Bridge between mitmproxy and playpen's policy.

mitmproxy loads Python addons and nothing else, so this file is Python. It
holds no policy: it asks over a unix socket and applies the answer. The policy
lives in spike/policy/, in TypeScript, and is tested without a proxy anywhere.

An unreachable or silent policy is a denial, so losing it severs egress rather
than releasing it.

PLAYPEN_POLICY_SOCKET  path to the policy server's socket
"""

import logging
import os
import socket

from mitmproxy import http, tcp, tls

SOCKET = os.environ.get("PLAYPEN_POLICY_SOCKET", "")

# The SNI is only available in tls_clienthello and the block has to happen in a
# later hook, so the verdict is carried across on the client address.
_verdicts: dict[tuple, str] = {}


def ask(host: str) -> str:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(2)
            s.connect(SOCKET)
            s.sendall(host.encode() + b"\n")
            return s.recv(64).decode().strip() or "deny"
    except OSError as e:
        logging.warning(f"PLAYPEN policy unreachable ({e}), denying {host!r}")
        return "deny"


class Verdict:
    def tls_clienthello(self, data: tls.ClientHelloData) -> None:
        sni = data.client_hello.sni or ""
        reply = ask(sni)
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
