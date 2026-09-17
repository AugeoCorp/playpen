#!/usr/bin/env bash
# Proves option C's mechanism without Lima: a network namespace with no route
# out, a proxy outside it, and socket files carrying connections both ways.
# qemu's part is played by running the client inside the fence directly, since
# the guest reaches the namespace's loopback through qemu either way.
#
# Everything here is unprivileged apart from `nsenter`, which only needs to be
# the namespace's creator.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RELAY="$HERE/relay.ts"
ADDON="$HERE/../mitmproxy/allowlist.py"
URL=${URL:-https://pypi.org/simple/}
HOST=${HOST:-pypi.org}
CONFDIR=${CONFDIR:-$HOME/.mitmproxy}

RUN=$(mktemp -d)
EGRESS="$RUN/egress.sock"
CONTROL="$RUN/control.sock"
PIDS=()
pass=0
fail=0

cleanup() {
	for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; done
	rm -rf "$RUN"
}
trap cleanup EXIT

bg() {
	"$@" >>"$RUN/log" 2>&1 &
	PIDS+=($!)
}

check() { # check <description> <expected> <actual>
	if [ "$2" = "$3" ]; then
		echo "  ok    $1"
		pass=$((pass + 1))
	else
		echo "  FAIL  $1 (wanted $2, got $3)"
		fail=$((fail + 1))
	fi
}

# curl, with this environment's own proxy settings stripped so they cannot
# quietly answer for us.
fetch() {
	env no_proxy= NO_PROXY= http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= \
		curl -sS -o /dev/null -w "%{http_code}" --max-time 12 "$@" 2>/dev/null
}

start_proxy() { # start_proxy <allowlist> <enforce>
	PLAYPEN_ALLOW="$1" PLAYPEN_ENFORCE="$2" bg mitmdump \
		--mode socks5@1081 -s "$ADDON" \
		--set connection_strategy=lazy --set confdir="$CONFDIR"
	MITM=${PIDS[-1]}
	for _ in $(seq 1 25); do
		grep -q "SOCKS v5 proxy listening" "$RUN/log" 2>/dev/null && break
		sleep 1
	done
}

echo "run dir: $RUN"

# --- the fence ------------------------------------------------------------
bg unshare -n sleep 900
NS=${PIDS[-1]}
sleep 1
nsenter -t "$NS" -n ip link set lo up
inside() { nsenter -t "$NS" -n "$@"; }

echo
echo "1. the fence is real"
t0=$(date +%s)
code=$(inside env no_proxy= https_proxy= HTTPS_PROXY= \
	curl -sS -o /dev/null -w "%{http_code}" --max-time 12 "$URL" 2>/dev/null)
t1=$(date +%s)
check "no route out from inside" "000" "${code:-000}"
check "and it fails fast rather than hanging" "yes" \
	"$([ $((t1 - t0)) -lt 5 ] && echo yes || echo no)"

# --- egress: guest side out ----------------------------------------------
start_proxy "$HOST" 1
bg node "$RELAY" unix-to-tcp "$EGRESS" 1081
sleep 1
bg nsenter -t "$NS" -n node "$RELAY" tcp-to-unix 1080 "$EGRESS"
INSIDE_RELAY=${PIDS[-1]}
sleep 2

echo
echo "2. the socket file is the only way out"
check "allowed host reaches the internet" "200" \
	"$(inside bash -c "$(declare -f fetch); fetch --socks5-hostname 127.0.0.1:1080 --cacert $CONFDIR/mitmproxy-ca-cert.pem $URL")"

kill -9 "$MITM" 2>/dev/null
sleep 2
check "killing the proxy severs it (fails closed)" "000" \
	"$(inside bash -c "$(declare -f fetch); fetch --socks5-hostname 127.0.0.1:1080 --cacert $CONFDIR/mitmproxy-ca-cert.pem $URL")"

echo
echo "3. policy still applies through the relay"
start_proxy "nothing.invalid" 1
sleep 2
check "denied host is blocked, not merely unreachable" "403" \
	"$(inside bash -c "$(declare -f fetch); fetch --socks5-hostname 127.0.0.1:1080 --cacert $CONFDIR/mitmproxy-ca-cert.pem $URL")"

# --- control path: our side in -------------------------------------------
echo
echo "4. the control path bridges back out"
bg nsenter -t "$NS" -n python3 -m http.server 8000 --bind 127.0.0.1
sleep 2
check "the stand-in for Lima's ssh port is unreachable from outside" "000" \
	"$(fetch http://127.0.0.1:8000/)"

bg nsenter -t "$NS" -n node "$RELAY" unix-to-tcp "$CONTROL" 8000
sleep 1
bg node "$RELAY" tcp-to-unix 8001 "$CONTROL"
sleep 2
check "and reachable once bridged, with no nsenter on our side" "200" \
	"$(fetch http://127.0.0.1:8001/)"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
