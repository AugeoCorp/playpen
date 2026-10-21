#!/bin/sh
# Prepares a Claude Code cloud container (Ubuntu, root, no KVM) to run
# playpen against real Lima VMs. Safe to re-run; each step skips itself once
# done. Run as root.
set -eu

LIMA_VERSION=2.2.0
NODE_VERSION=24.11.1
REPO=$(cd "$(dirname "$0")/../../.." && pwd)

if ! command -v qemu-system-x86_64 >/dev/null || ! command -v socat >/dev/null ||
	! command -v bwrap >/dev/null || ! command -v ssh-keygen >/dev/null; then
	apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
		qemu-system-x86 qemu-utils socat bubblewrap openssh-client genisoimage
fi

if [ "$(limactl --version 2>/dev/null)" != "limactl version $LIMA_VERSION" ]; then
	tmp=$(mktemp -d)
	curl -sSfL -o "$tmp/lima.tgz" \
		"https://github.com/lima-vm/lima/releases/download/v$LIMA_VERSION/lima-$LIMA_VERSION-Linux-x86_64.tar.gz"
	rm -rf /opt/lima && mkdir -p /opt/lima && tar -C /opt/lima -xzf "$tmp/lima.tgz"
	ln -sf /opt/lima/bin/limactl /usr/local/bin/limactl
	rm -rf "$tmp"
fi

if [ "$(/opt/node/bin/node --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
	tmp=$(mktemp -d)
	curl -sSfL -o "$tmp/node.tar.xz" \
		"https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
	rm -rf /opt/node && mkdir -p /opt/node
	tar -C /opt/node --strip-components=1 -xJf "$tmp/node.tar.xz"
	rm -rf "$tmp"
fi

# limactl refuses to run as root.
id runner >/dev/null 2>&1 || useradd -m runner

# The host-side network helper reaches real hosts through the container's
# egress proxy, so the test user needs its CA.
install -m 644 /root/.ccr/ca-bundle.crt /opt/ca-bundle.crt

# The test user runs the repo's CLI in place.
dir=$REPO
while [ "$dir" != / ]; do
	chmod o+x "$dir"
	dir=$(dirname "$dir")
done
chmod -R o+rX "$REPO"

# `pp <args>` is `playpen <args>` as runner, in $PP_CWD. env -i keeps the
# container's own tokens out of the test user's environment.
cat >/usr/local/bin/pp <<EOF
#!/bin/sh
cd "\${PP_CWD:-/home/runner/scratch}" || exit 1
exec setpriv --reuid runner --regid runner --init-groups \\
	env -i HOME=/home/runner USER=runner TERM="\${TERM:-xterm}" \\
	PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin \\
	XDG_DATA_HOME=/home/runner/pp-data NODE_EXTRA_CA_CERTS=/opt/ca-bundle.crt \\
	HTTPS_PROXY="\$HTTPS_PROXY" HTTP_PROXY="\$HTTP_PROXY" NO_PROXY="\$NO_PROXY" \\
	https_proxy="\$HTTPS_PROXY" http_proxy="\$HTTP_PROXY" no_proxy="\$NO_PROXY" \\
	node $REPO/src/cli.ts "\$@"
EOF
chmod 755 /usr/local/bin/pp

setpriv --reuid runner --regid runner --init-groups \
	sh -c 'mkdir -p /home/runner/scratch'
pp doctor
