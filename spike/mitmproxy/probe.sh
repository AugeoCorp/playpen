#!/usr/bin/env bash
# Answers the mitmproxy questions docs/NETWORK.md leaves open. Run it on the
# host, not in a sandbox. See README.md for what each result means.
set -uo pipefail

TARGET=${TARGET:-curl}
URL=${URL:-https://example.com/}
CONFDIR=${CONFDIR:-$HOME/.mitmproxy}
ADDON="$(cd "$(dirname "$0")" && pwd)/allowlist.py"

command -v mitmdump >/dev/null || {
	echo "mitmdump not on PATH: uv tool install --python 3.13 mitmproxy" >&2
	exit 1
}

REDIRECTOR=$(mitmdump --version >/dev/null 2>&1 && \
	dirname "$(command -v mitmdump)")/mitmproxy-linux-redirector
[ -x "$REDIRECTOR" ] || {
	echo "no mitmproxy-linux-redirector beside mitmdump; the mitmproxy-linux" >&2
	echo "wheel is missing, so this build has no Linux local mode" >&2
	exit 1
}

log=$(mktemp -d)/mitm.log

# The redirector attaches its eBPF program at the cgroup v2 root and finds it
# by that fixed path.
grep -q ' /sys/fs/cgroup cgroup2 ' /proc/self/mountinfo ||
	echo "WARNING: /sys/fs/cgroup is not cgroup2; the redirector will fail"

redirectors() {
	local n=0 p
	for p in /proc/[0-9]*; do
		[ "$(readlink "$p/exe" 2>/dev/null)" = "$REDIRECTOR" ] && n=$((n + 1))
	done
	echo "$n"
}

tundevs() { sed -n 's/^ *\(tun[0-9]*\):.*/\1/p' /proc/net/dev | tr '\n' ' '; }

start() {
	rm -f "$log"
	PLAYPEN_ALLOW="${1-}" PLAYPEN_ENFORCE="${2-0}" \
		mitmdump --mode "local:$TARGET" -s "$ADDON" \
		--set connection_strategy=lazy --set confdir="$CONFDIR" \
		>"$log" 2>&1 &
	MITM=$!
	for _ in $(seq 1 30); do
		grep -q "Local redirector started" "$log" && break
		sleep 1
	done
	sleep 4
}

fetch() {
	curl -sS "$@" -o /dev/null -w "    exit=%{exitcode} code=%{http_code}\n" \
		--max-time 15 "$URL" 2>&1 | head -2
}

echo "### baseline: no interception"
fetch
echo "    redirectors=$(redirectors) tun=[$(tundevs)]"

echo
echo "### 1. interception, allow-all, log only"
start "" 0
echo "  untrusted client (expect a certificate error unless the CA is installed):"
fetch
echo "  client trusting our CA:"
fetch --cacert "$CONFDIR/mitmproxy-ca-cert.pem"
echo "  verdicts:"
grep PLAYPEN "$log" | tail -3 | sed 's/^/    /'
echo "  DNS seen by the proxy:"
grep -c "DNS QUERY" "$log" | sed 's/^/    queries=/'

echo
echo "### 2. an unlisted process must be untouched"
python3 -c "
import urllib.request
try:
    print('    python3 code=', urllib.request.urlopen('$URL', timeout=15).status)
except Exception as e:
    print('    python3 err=', type(e).__name__, str(e)[:70])
"

echo
echo "### 3. enforcement: allowlist that does not cover \$URL"
kill -9 "$MITM" 2>/dev/null
sleep 3
start "invalid.example" 1
fetch --cacert "$CONFDIR/mitmproxy-ca-cert.pem"
grep PLAYPEN "$log" | tail -3 | sed 's/^/    /'

echo
echo "### 4. fail open or closed: SIGKILL the proxy, then retry"
kill -9 "$MITM" 2>/dev/null
sleep 5
echo "    redirectors=$(redirectors) tun=[$(tundevs)]  <- nonzero means a leak"
fetch
echo "    a 200 here means the redirect FAILS OPEN"

echo
echo "### 5. does the filter follow children? (target this shell, curl from it)"
start "" 0
kill -9 "$MITM" 2>/dev/null
sleep 2
rm -f "$log"
PLAYPEN_ALLOW="" mitmdump --mode "local:$$" -s "$ADDON" \
	--set confdir="$CONFDIR" >"$log" 2>&1 &
MITM=$!
for _ in $(seq 1 30); do
	grep -q "Local redirector started" "$log" && break
	sleep 1
done
sleep 4
fetch
echo "    a clean 200 means pid targeting does NOT cover descendants"
kill -9 "$MITM" 2>/dev/null

echo
echo "log: $log"
