import { defineLayer } from "./types.ts";

export function buildTools() {
	return defineLayer({
		name: "build-tools",
		packages: [
			"ca-certificates",
			"curl",
			"git",
			"jq",
			"less",
			"ripgrep",
			"build-essential",
			"unzip",
		],
	});
}

/**
 * The distro package is Node 22 built without Amaro, so `node file.ts` fails
 * with ERR_NO_TYPESCRIPT at any version: enough to run Claude Code, not enough
 * to run playpen's own tests in the guest. The official tarball carries type
 * stripping, and installs the same way on every distro.
 *
 * .tar.gz rather than .tar.xz so the layer needs no decompressor the base image
 * might not ship, and no package name that differs per distro.
 */
const NODE_VERSION = "26.8.2";

export function node() {
	return defineLayer({
		name: "node",
		script: [
			`if [ "$(node -v 2>/dev/null)" != "v${NODE_VERSION}" ]; then`,
			'  case "$(uname -m)" in',
			"    x86_64) arch=x64 ;;",
			"    aarch64) arch=arm64 ;;",
			'    *) echo >&2 "unsupported architecture: $(uname -m)"; exit 1 ;;',
			"  esac",
			`  dist="https://nodejs.org/dist/v${NODE_VERSION}"`,
			`  tarball="node-v${NODE_VERSION}-linux-$arch.tar.gz"`,
			'  tmp="$(mktemp -d)"',
			`  trap 'rm -rf "$tmp"' EXIT`,
			'  curl -fsSL -o "$tmp/$tarball" "$dist/$tarball"',
			'  curl -fsSL -o "$tmp/SHASUMS256.txt" "$dist/SHASUMS256.txt"',
			// Unverified, this layer would install whatever a proxy handed back.
			'  (cd "$tmp" && grep " $tarball$" SHASUMS256.txt | sha256sum -c -)',
			'  tar -xzf "$tmp/$tarball" -C /usr/local --strip-components=1 \\',
			"    --no-same-owner --wildcards --no-wildcards-match-slash \\",
			"    --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'",
			"fi",
		].join("\n"),
	});
}

/**
 * Per-project toolchains from whatever the repo already declares: mise.toml,
 * .tool-versions, .nvmrc, .node-version. Not package.json `engines`, which mise
 * does not read. Deliberately does not manage the base
 * Node: global npm packages install per Node version, so a project pin that
 * moved `node` would take `claude` with it. node() stays the floor.
 *
 * Tools install on first use, so a project pinning a toolchain pays a download
 * on its first boot and needs guest network. The base image stays as baked.
 */
const MISE_VERSION = "2026.9.10";

export function mise() {
	return defineLayer({
		name: "mise",
		script: [
			`if ! mise --version 2>/dev/null | grep -q "^${MISE_VERSION} "; then`,
			'  case "$(uname -m)" in',
			"    x86_64) arch=x64 ;;",
			"    aarch64) arch=arm64 ;;",
			'    *) echo >&2 "unsupported architecture: $(uname -m)"; exit 1 ;;',
			"  esac",
			`  rel="https://github.com/jdx/mise/releases/download/v${MISE_VERSION}"`,
			`  binary="mise-v${MISE_VERSION}-linux-$arch"`,
			'  tmp="$(mktemp -d)"',
			`  trap 'rm -rf "$tmp"' EXIT`,
			'  curl -fsSL -o "$tmp/$binary" "$rel/$binary"',
			'  curl -fsSL -o "$tmp/SHASUMS256.txt" "$rel/SHASUMS256.txt"',
			// Entries are listed as ./<name>, which is also how sha256sum -c looks them up.
			'  (cd "$tmp" && grep " \\./$binary$" SHASUMS256.txt | sha256sum -c -)',
			'  install -m 0755 "$tmp/$binary" /usr/local/bin/mise',
			"fi",
			"mkdir -p /etc/mise",
			"cat > /etc/mise/config.toml <<'TOML'",
			"[settings]",
			"# An interactive trust prompt would hang `playpen run`, which is not a",
			"# terminal. Nothing is conceded: the guest already runs the project's own",
			"# code, and the host-side gate in src/session/trust.ts is untouched.",
			'trusted_config_paths = ["/"]',
			"# Off by default since mise 2024. Without this only mise.toml and",
			"# .tool-versions are read, which almost no existing repo has.",
			'idiomatic_version_file_enable_tools = ["node", "python", "ruby", "go"]',
			"TOML",
			"cat > /etc/profile.d/mise.sh <<'SH'",
			"# limactl shell runs `<shell> -l -c <cmd>`, so this is sourced for",
			"# `playpen run` and `playpen claude`, not just an interactive shell.",
			"#",
			"# mise writes a shim only for a tool it has already installed, and nothing",
			"# else in the sandbox installs one: the base is baked with no project",
			"# mounted. Without this a pinned project resolves to the baked floor and",
			"# says nothing. Lima cds before exec'ing the shell, so cwd is the project",
			"# by now. Probed rather than always installed: the probe is ~10ms and",
			"# silent, while `mise install --quiet` is silent even during a download,",
			"# which would make a slow first use look like a hang.",
			'if [ -n "$(mise ls --missing 2>/dev/null)" ]; then',
			"  mise install >/dev/null || true",
			"fi",
			"case $- in",
			'  *i*) eval "$(mise activate bash)" ;;',
			'  *) export PATH="$HOME/.local/share/mise/shims:$PATH" ;;',
			"esac",
			"SH",
		].join("\n"),
	});
}

/**
 * Runs inside the guest's network namespace (see docs/NETWORK.md, option B)
 * and hands every packet to the host-side relay at 192.168.5.2:1080, the
 * address Lima's user-mode networking gives the guest for the host's
 * loopback. `--dns virtual` makes tun2proxy answer DNS itself, so the guest
 * needs no resolver. `--bypass 192.168.5.0/24` is load-bearing: without it,
 * the guest's replies to qemu's gateway on that subnet would go into the
 * tunnel instead, and the ssh session Lima drives the VM through would die.
 */
const TUN2PROXY_VERSION = "0.8.3";

/**
 * v0.8.3 publishes no checksum file alongside its release assets (checked
 * SHA256SUMS, sha256sum.txt, checksums.txt, and `<asset>.sha256`: all 404 on
 * 2026-09-17). These are sha256 hashes of the release assets themselves,
 * computed from a direct download of
 * https://github.com/tun2proxy/tun2proxy/releases/tag/v0.8.3 on 2026-09-17.
 * There is no aarch64-musl asset for this release; -gnu is the aarch64 build
 * published, which is fine since the base distro is glibc.
 */
const TUN2PROXY_SHA256: Record<string, string> = {
	"tun2proxy-x86_64-unknown-linux-musl.zip":
		"17a784e88b7b533984d9f4d83a20f9a9311678f27548c6850b57bbc29bbbf604",
	"tun2proxy-aarch64-unknown-linux-gnu.zip":
		"b6f5a87f3fee2ba483b06cf987fb058ca7a835ee47b17b098aa2c0d4ce70aa52",
};

export function tun2proxy() {
	return defineLayer({
		name: "tun2proxy",
		script: [
			`if ! tun2proxy-bin --version 2>/dev/null | grep -q "^tun2proxy ${TUN2PROXY_VERSION} "; then`,
			'  case "$(uname -m)" in',
			"    x86_64) asset=tun2proxy-x86_64-unknown-linux-musl.zip ;;",
			"    aarch64) asset=tun2proxy-aarch64-unknown-linux-gnu.zip ;;",
			'    *) echo >&2 "unsupported architecture: $(uname -m)"; exit 1 ;;',
			"  esac",
			`  rel="https://github.com/tun2proxy/tun2proxy/releases/download/v${TUN2PROXY_VERSION}"`,
			'  tmp="$(mktemp -d)"',
			`  trap 'rm -rf "$tmp"' EXIT`,
			'  curl -fsSL -o "$tmp/$asset" "$rel/$asset"',
			'  case "$asset" in',
			...Object.entries(TUN2PROXY_SHA256).map(
				([asset, sha]) => `    ${asset}) sha256=${sha} ;;`,
			),
			"  esac",
			'  echo "$sha256  $tmp/$asset" | sha256sum -c -',
			'  unzip -oq "$tmp/$asset" tun2proxy-bin -d "$tmp"',
			'  install -m 0755 "$tmp/tun2proxy-bin" /usr/local/bin/tun2proxy-bin',
			"fi",
			"cat > /etc/systemd/system/playpen-tun2proxy.service <<'UNIT'",
			"[Unit]",
			"Description=playpen guest-side transparent proxy (tun2proxy)",
			"After=network-online.target",
			"Wants=network-online.target",
			"",
			"[Service]",
			"ExecStart=/usr/local/bin/tun2proxy-bin --proxy http://192.168.5.2:1080 --setup --dns virtual --bypass 192.168.5.0/24",
			"Restart=always",
			"RestartSec=2",
			"",
			"[Install]",
			"WantedBy=multi-user.target",
			"UNIT",
			// The bake runs with real network still up; starting the service now
			// would cut the baking process itself off mid-provision, since nothing
			// is relaying 192.168.5.2:1080 outside a running sandbox. Enabling
			// only means it starts on the next boot, which is the sandbox's.
			"systemctl enable playpen-tun2proxy.service",
		].join("\n"),
	});
}

export function python() {
	return defineLayer({
		name: "python",
		packages: ["python3", "python3-pip", "python3-venv"],
	});
}

export function claudeCode() {
	return defineLayer({
		name: "claude-code",
		script: [
			"if command -v claude >/dev/null 2>&1; then",
			'  echo "claude already installed"',
			"else",
			"  npm install -g @anthropic-ai/claude-code",
			"fi",
			// Claude Code currently ships a native binary, which no PATH lookup can
			// redirect. If npm goes back to a JS entry point, its shebang is
			// `/usr/bin/env node`, which mise shims would resolve to whatever Node the
			// project pinned; pin it to the floor so no repo chooses the agent's Node.
			// Guarded because the binary is ~228MB and sed would rewrite it wholesale.
			'target="$(readlink -f "$(command -v claude)")"',
			// A `#!` alone is not enough: a native-binary npm package often ships a
			// POSIX shell launcher, and pointing that at Node would feed shell to a
			// JS parser. Only a node shebang is rewritten.
			`if head -n1 "$target" | grep -qE '^#!.*node$'; then`,
			'  sed -i "1s|^#!.*|#!/usr/local/bin/node|" "$target"',
			"fi",
		].join("\n"),
	});
}

/**
 * Nothing in a disposable build VM reads atime, so the metadata writes it costs
 * buy nothing. No fstab edit: provision scripts re-run on every boot.
 */
export function noatime() {
	return defineLayer({
		name: "noatime",
		script: [
			"if ! findmnt -no OPTIONS / | grep -q noatime; then",
			"  mount -o remount,noatime /",
			"fi",
		].join("\n"),
	});
}
