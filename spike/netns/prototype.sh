#!/usr/bin/env bash
# Option C's mechanism without a VM: a network namespace with no route out, a
# proxy outside it, and socat carrying connections across on socket files.
# qemu's part is played by running the client inside the fence directly, since
# the guest reaches the namespace's loopback through qemu either way.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ADDON="$HERE/../mitmproxy/verdict.py"
POLICY="$HERE/../policy/policy.ts"
URL=${URL:-https://pypi.org/simple/}
HOST=${HOST:-pypi.org}
CONFDIR=${CONFDIR:-$HOME/.mitmproxy}

RUN=$(mktemp -d)
EGRESS="$RUN/egress.sock"
CONTROL="$RUN/control.sock"
DECIDE="$RUN/policy.sock"
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
check() {
	if [ "$2" = "$3" ]; then
		echo "  ok    $1"
		pass=$((pass + 1))
	else
		echo "  FAIL  $1 (wanted $2, got $3)"
		fail=$((fail + 1))
	fi
}
# curl, with this environment's own proxy settings stripped so they cannot
# quietly answer for us. no_proxy matters as much as the rest: an entry there
# makes curl ignore the proxy we pass on the command line.
fetch() {
	env no_proxy= NO_PROXY= http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= \
		curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "$@" 2>/dev/null | tail -c 3
}

policy() { # policy <allow> <enforce|report>
	bg node "$POLICY" "$DECIDE" "$1" "$2"
	POLICY_PID=${PIDS[-1]}
	until [ -S "$DECIDE" ]; do sleep 1; done
}
proxy() {
	PLAYPEN_POLICY_SOCKET="$DECIDE" bg mitmdump --mode socks5@1081 -s "$ADDON" \
		--set connection_strategy=lazy --set confdir="$CONFDIR"
	MITM=${PIDS[-1]}
	until grep -q "SOCKS v5 proxy listening" "$RUN/log" 2>/dev/null; do
		kill -0 "$MITM" 2>/dev/null || {
			echo "the proxy died on startup:"
			tail -3 "$RUN/log"
			exit 1
		}
		sleep 1
	done
	sleep 2
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
check "no route out from inside" "000" \
	"$(inside bash -c "$(declare -f fetch); fetch $URL")"
t1=$(date +%s)
check "and it fails fast rather than hanging" "yes" \
	"$([ $((t1 - t0)) -lt 5 ] && echo yes || echo no)"

# --- egress ---------------------------------------------------------------
policy "$HOST" enforce
proxy
bg socat "UNIX-LISTEN:$EGRESS,fork" TCP:127.0.0.1:1081
until [ -S "$EGRESS" ]; do sleep 1; done
bg nsenter -t "$NS" -n socat TCP-LISTEN:1080,fork,bind=127.0.0.1 "UNIX-CONNECT:$EGRESS"
sleep 2

echo
echo "2. the socket file is the only way out"
check "an allowed host reaches the internet" "200" \
	"$(inside bash -c "$(declare -f fetch); fetch --socks5-hostname 127.0.0.1:1080 --cacert $CONFDIR/mitmproxy-ca-cert.pem $URL")"
kill -9 "$MITM" 2>/dev/null
sleep 2
check "killing the proxy severs it (fails closed)" "000" \
	"$(inside bash -c "$(declare -f fetch); fetch --socks5-hostname 127.0.0.1:1080 $URL")"

echo
echo "3. policy still applies through the relay"
proxy
check "a denied host is blocked, not merely unreachable" "403" \
	"$(inside bash -c "$(declare -f fetch); fetch --socks5-hostname 127.0.0.1:1080 --cacert $CONFDIR/mitmproxy-ca-cert.pem https://files.pythonhosted.org/")"
kill -9 "$POLICY_PID" 2>/dev/null
sleep 1
check "losing the policy denies rather than releases" "403" \
	"$(inside bash -c "$(declare -f fetch); fetch --socks5-hostname 127.0.0.1:1080 --cacert $CONFDIR/mitmproxy-ca-cert.pem $URL")"

# --- control path ---------------------------------------------------------
echo
echo "4. the control path bridges back out"
bg nsenter -t "$NS" -n python3 -m http.server 8000 --bind 127.0.0.1
sleep 2
check "a service inside is unreachable from outside" "000" "$(fetch http://127.0.0.1:8000/)"
bg nsenter -t "$NS" -n socat "UNIX-LISTEN:$CONTROL,fork" TCP:127.0.0.1:8000
sleep 1
bg socat TCP-LISTEN:8001,fork,bind=127.0.0.1 "UNIX-CONNECT:$CONTROL"
sleep 2
check "and reachable once bridged, with no nsenter on our side" "200" \
	"$(fetch http://127.0.0.1:8001/)"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
