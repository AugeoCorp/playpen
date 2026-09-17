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
# An allowed host is passed through undecrypted, so the guest verifies the real
# certificate. Where this machine's own egress is TLS-intercepted, the guest has
# no reason to trust the intercepting CA: set GUEST_CURL_OPTS=-k, or install it.
GUEST_CURL_OPTS=${GUEST_CURL_OPTS:-}
URL=${URL:-https://pypi.org/simple/}
HOST=${HOST:-pypi.org}
HERE="$(cd "$(dirname "$0")" && pwd)"
RELAY="$HERE/relay.ts"
ADDON="$HERE/../mitmproxy/allowlist.py"
RUN=${RUN:-$HOME/fence}
EGRESS="$RUN/egress.sock"
CONTROL="$RUN/control.sock"

# ---------------------------------------------------------------- inside ---
if [ "${1-}" = "--inside" ]; then
	node "$RELAY" tcp-to-unix 1080 "$EGRESS" >>"$RUN/inside.log" 2>&1 &
	python3 -m http.server 7788 --bind 127.0.0.1 >/dev/null 2>&1 &
	limactl start --name="$INSTANCE" --tty=false "$RUN/vm.yaml" >>"$RUN/inside.log" 2>&1
	port=$(limactl list --format '{{.SSHLocalPort}}' "$INSTANCE" | tr -d '[:space:]')
	echo "$port" >"$RUN/sshport"
	node "$RELAY" unix-to-tcp "$CONTROL" "$port" >>"$RUN/inside.log" 2>&1 &
	# Prove from in here that the fence holds, before anything is bridged.
	limactl shell "$INSTANCE" -- sh -c \
		"env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u no_proxy -u NO_PROXY \
		 curl -sS -o /dev/null -w '%{http_code}' --max-time 15 $URL" \
		>"$RUN/guest-direct" 2>/dev/null
	limactl shell "$INSTANCE" -- sh -c \
		"env -u no_proxy -u NO_PROXY curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://192.168.5.2:7788/" \
		>"$RUN/guest-loopback" 2>/dev/null
	ls "$HOME/.lima/$INSTANCE" | grep -c "ssh.sock" >"$RUN/has-ssh-sock"
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
# Runs in the guest, through the bridged control path, from out here.
guest() {
	limactl shell "$INSTANCE" -- sh -c \
		"env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u no_proxy -u NO_PROXY $1" \
		2>/dev/null | tail -c 3
}
proxy() { # proxy <allowlist> <enforce>
	PLAYPEN_ALLOW="$1" PLAYPEN_ENFORCE="$2" bg mitmdump --mode socks5@1081 \
		-s "$ADDON" --set connection_strategy=lazy
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

proxy "$HOST" 1
bg node "$RELAY" unix-to-tcp "$EGRESS" 1081 
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
echo "  lima leaves an ssh control socket behind: $(cat "$RUN/has-ssh-sock")"
check "limactl reaches the VM from out here, before any bridge" "0" \
	"$(limactl shell "$INSTANCE" -- true >/dev/null 2>&1; echo $?)"
bg node "$RELAY" tcp-to-unix "$SSHPORT" "$CONTROL"
sleep 3
check "and reaches it once bridged, with nothing joining the fence" "0" \
	"$(limactl shell "$INSTANCE" -- true >/dev/null 2>&1; echo $?)"

echo
echo "4. what the guest can and cannot reach"
check "no internet from the guest" "000" "$(cat "$RUN/guest-direct" | tail -c 3)"
check "192.168.5.2 reaches the fence's own loopback" "200" \
	"$(cat "$RUN/guest-loopback" | tail -c 3)"
check "the egress chain works from outside the fence" "200" \
	"$(env no_proxy= NO_PROXY= https_proxy= HTTPS_PROXY= curl -sS -o /dev/null -w '%{http_code}' --max-time 30 --socks5-hostname 127.0.0.1:1081 "$URL" 2>/dev/null | tail -c 3)"
check "and the relay on 192.168.5.2 carries the guest out" "200" \
	"$(guest "curl -sS $GUEST_CURL_OPTS -o /dev/null -w '%{http_code}' --max-time 120 --socks5-hostname 192.168.5.2:1080 $URL")"

echo
echo "5. policy still governs what comes through"
kill -9 "$MITM" 2>/dev/null
sleep 2
check "killing the proxy severs the guest (fails closed)" "000" \
	"$(guest "curl -sS -o /dev/null -w '%{http_code}' --max-time 90 --socks5-hostname 192.168.5.2:1080 $URL")"

echo "--- second proxy ---" >>"$RUN/log"
proxy "nothing.invalid" 1
got=$(guest "curl -sS -o /dev/null -w '%{http_code}' --max-time 120 --socks5-hostname 192.168.5.2:1080 $URL")
check "the proxy saw the domain and denied it" "yes" \
	"$(sed -n '/--- second proxy ---/,$p' "$RUN/log" | grep -q "PLAYPEN deny sni='$HOST'" && echo yes || echo no)"
check "and the guest got nothing" "000" "$got"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
