#!/usr/bin/env bash
# The same proof as prototype.sh, with a real Lima VM in the middle instead of
# a stand-in client. No root anywhere: bubblewrap makes the fence, keeps our
# own uid, and brings loopback up inside it.
#
# Nothing can join a bubblewrap namespace from outside, which is the point:
# everything that belongs inside is started by the one invocation below, and
# everything else reaches in through a socket file.
set -uo pipefail

INSTANCE=${INSTANCE:-pp}
URL=${URL:-https://pypi.org/simple/}
HOST=${HOST:-pypi.org}
DENIED_URL=${DENIED_URL:-https://files.pythonhosted.org/}
# An allowed host is passed through undecrypted, so the guest verifies the real
# certificate. Where this machine's own egress is TLS-intercepted, the guest has
# no reason to trust the intercepting CA: set GUEST_CURL_OPTS=-k, or install it.
GUEST_CURL_OPTS=${GUEST_CURL_OPTS:-}
# Set to a linux-x86_64 tun2proxy binary to also test the guest reaching the
# relay by route rather than by proxy setting.
TUN2PROXY=${TUN2PROXY:-}
HERE="$(cd "$(dirname "$0")" && pwd)"
ADDON="$HERE/../mitmproxy/verdict.py"
POLICY="$HERE/../policy/policy.ts"
RUN=${RUN:-$HOME/fence}
EGRESS="$RUN/egress.sock"
CONTROL="$RUN/control.sock"
DECIDE="$RUN/policy.sock"

# ---------------------------------------------------------------- inside ---
if [ "${1-}" = "--inside" ]; then
	socat TCP-LISTEN:1080,fork,bind=127.0.0.1 "UNIX-CONNECT:$EGRESS" \
		>>"$RUN/inside.log" 2>&1 &
	python3 -m http.server 7788 --bind 127.0.0.1 >/dev/null 2>&1 &
	limactl start --name="$INSTANCE" --tty=false "$RUN/vm.yaml" >>"$RUN/inside.log" 2>&1
	port=$(limactl list --format '{{.SSHLocalPort}}' "$INSTANCE" | tr -d '[:space:]')
	echo "$port" >"$RUN/sshport"
	socat "UNIX-LISTEN:$CONTROL,fork" "TCP:127.0.0.1:$port" >>"$RUN/inside.log" 2>&1 &
	# Prove from in here that the fence holds, before anything is bridged.
	limactl shell "$INSTANCE" -- sh -c \
		"env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u no_proxy -u NO_PROXY \
		 curl -sS -o /dev/null -w '%{http_code}' --max-time 15 $URL" \
		>"$RUN/guest-direct" 2>/dev/null
	limactl shell "$INSTANCE" -- sh -c \
		"env -u no_proxy -u NO_PROXY curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://192.168.5.2:7788/" \
		>"$RUN/guest-loopback" 2>/dev/null
	touch "$RUN/ready"
	sleep 1800
	exit 0
fi

# --------------------------------------------------------------- outside ---
PIDS=()
pass=0
fail=0
cleanup() {
	for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; done
	limactl stop -f "$INSTANCE" >/dev/null 2>&1
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
# Runs in the guest, through the bridged control path, from out here. Lima
# copies our proxy environment into the guest, and a no_proxy entry there makes
# curl ignore the proxy we pass on the command line.
guest_raw() {
	limactl shell "$INSTANCE" -- sh -c \
		"env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u no_proxy -u NO_PROXY $1" \
		2>/dev/null
}
guest() { guest_raw "$1" | tail -c 3; }
policy() { # policy <allow> <enforce|report>
	bg node "$POLICY" "$DECIDE" "$1" "$2"
	POLICY_PID=${PIDS[-1]}
	until [ -S "$DECIDE" ]; do sleep 1; done
}
proxy() {
	PLAYPEN_POLICY_SOCKET="$DECIDE" bg mitmdump --mode socks5@1081 -s "$ADDON" \
		--set connection_strategy=lazy
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

limactl stop -f "$INSTANCE" >/dev/null 2>&1
limactl delete -f "$INSTANCE" >/dev/null 2>&1
rm -rf "$RUN"
mkdir -p "$RUN"

cat >"$RUN/vm.yaml" <<YAML
vmType: "qemu"
os: "Linux"
arch: "x86_64"
images:
  - location: "https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img"
    arch: "x86_64"
cpus: 2
memory: "2GiB"
disk: "8GiB"
mounts: []
containerd: {system: false, user: false}
ssh: {loadDotSSHPubKeys: false}
hostResolver:
  enabled: false
YAML

policy "$HOST" enforce
proxy
bg socat "UNIX-LISTEN:$EGRESS,fork" TCP:127.0.0.1:1081
until [ -S "$EGRESS" ]; do sleep 1; done

echo "1. the fence"
check "bubblewrap keeps our own uid" "$(id -u)" \
	"$(bwrap --unshare-net --dev-bind / / id -u)"
check "and still brings loopback up" "UP" \
	"$(bwrap --unshare-net --dev-bind / / sh -c 'ip -br addr show lo | grep -o 127.0.0.1 >/dev/null && echo UP')"
check "with no route out of it" "000" \
	"$(bwrap --unshare-net --dev-bind / / env no_proxy= https_proxy= HTTPS_PROXY= \
		curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$URL" 2>/dev/null | tail -c 3)"

echo
echo "2. Lima inside it"
bg bwrap --unshare-net --dev-bind / / --die-with-parent "$0" --inside
until [ -f "$RUN/ready" ] || grep -q "level=fatal" "$RUN/inside.log" 2>/dev/null; do sleep 5; done
check "the VM boots with no network under it" "yes" \
	"$([ -f "$RUN/ready" ] && echo yes || echo no)"
[ -f "$RUN/ready" ] || {
	tail -5 "$RUN/inside.log"
	exit 1
}
SSHPORT=$(cat "$RUN/sshport")
echo "  ssh port: $SSHPORT"

echo
echo "3. the control path"
check "limactl reaches the VM over lima's own ssh socket" "0" \
	"$(
		limactl shell "$INSTANCE" -- true >/dev/null 2>&1
		echo $?
	)"
bg socat "TCP-LISTEN:$SSHPORT,fork,bind=127.0.0.1" "UNIX-CONNECT:$CONTROL"
sleep 3
check "and over our bridge, with nothing joining the fence" "0" \
	"$(
		limactl shell "$INSTANCE" -- true >/dev/null 2>&1
		echo $?
	)"

echo
echo "4. what the guest can and cannot reach"
check "no internet from the guest" "000" "$(tail -c 3 "$RUN/guest-direct")"
check "192.168.5.2 reaches the fence's own loopback" "200" \
	"$(tail -c 3 "$RUN/guest-loopback")"
check "and the relay on it carries the guest out" "200" \
	"$(guest "curl -sS $GUEST_CURL_OPTS -o /dev/null -w '%{http_code}' --max-time 120 --socks5-hostname 192.168.5.2:1080 $URL")"

if [ -n "$TUN2PROXY" ]; then
	echo
	echo "5. as a route, with no proxy setting anywhere"
	limactl copy "$TUN2PROXY" "$INSTANCE:/tmp/tun2proxy" >>"$RUN/log" 2>&1
	limactl shell "$INSTANCE" -- sudo install -m 755 /tmp/tun2proxy /usr/local/bin/tun2proxy \
		>>"$RUN/log" 2>&1
	# Bounded, so a mistake in the routing setup heals itself instead of
	# costing us the ssh session the rest of the run needs. The bypass keeps
	# the reply path to qemu's gateway off the tun for the same reason.
	limactl shell "$INSTANCE" -- sudo sh -c \
		"nohup timeout 180 tun2proxy --proxy socks5://192.168.5.2:1080 --setup \
		 --dns virtual --bypass 192.168.5.0/24 >/tmp/tun2proxy.log 2>&1 &" \
		>>"$RUN/log" 2>&1
	sleep 12
	check "traffic to the internet now leaves via a tun device" "tun" \
		"$(guest_raw "ip route get 1.1.1.1 | grep -oE 'tun[0-9]+' | head -1 | tr -d '0-9'")"
	# --noproxy '*' makes curl ignore every proxy setting it can see, so a
	# success here is the route doing the work and nothing else.
	check "a request that refuses every proxy setting still gets out" "200" \
		"$(guest "curl -sS $GUEST_CURL_OPTS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 120 $URL")"
	check "and a raw socket that has never heard of a proxy gets out" "open" \
		"$(guest_raw "timeout 60 bash -c 'exec 3<>/dev/tcp/pypi.org/443' >/dev/null 2>&1 && echo open || echo shut")"
	check "a denied host is still denied on this path" "403" \
		"$(guest "curl -sS $GUEST_CURL_OPTS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 120 $DENIED_URL")"
	limactl shell "$INSTANCE" -- sudo pkill -f tun2proxy >/dev/null 2>&1
	sleep 5
fi

echo
echo "6. policy still governs what comes through"
check "a denied host is blocked, not merely unreachable" "403" \
	"$(guest "curl -sS $GUEST_CURL_OPTS -o /dev/null -w '%{http_code}' --max-time 120 --socks5-hostname 192.168.5.2:1080 $DENIED_URL")"
kill -9 "$POLICY_PID" 2>/dev/null
sleep 1
check "losing the policy denies rather than releases" "403" \
	"$(guest "curl -sS $GUEST_CURL_OPTS -o /dev/null -w '%{http_code}' --max-time 120 --socks5-hostname 192.168.5.2:1080 $URL")"
kill -9 "$MITM" 2>/dev/null
sleep 2
check "killing the proxy severs the guest (fails closed)" "000" \
	"$(guest "curl -sS $GUEST_CURL_OPTS -o /dev/null -w '%{http_code}' --max-time 90 --socks5-hostname 192.168.5.2:1080 $URL")"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
