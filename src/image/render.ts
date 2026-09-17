import { createHash } from "node:crypto";
import type { ImageDef } from "./types.ts";

export interface ImageOptions {
	cpus: number;
	memory: string;
	disk: string;
	mountType: "9p" | "virtiofs" | "reverse-sshfs";
}

export interface SandboxOptions extends ImageOptions {
	/** Host directory to mount read-write, at the same path inside the guest. */
	mount: string;
}

export interface Rendered {
	template: Record<string, unknown>;
	/** Identifies the image definition; changes whenever any layer changes. */
	contentHash: string;
}

/** Key order must not perturb the hash. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function imageHash(def: ImageDef): string {
	const shape = {
		distro: def.distro.name,
		base: def.distro.baseTemplate,
		layers: def.layers.map((l) => ({
			name: l.name,
			packages: l.packages ?? [],
			script: l.script ?? "",
			mode: l.mode ?? "system",
			env: l.env ?? {},
		})),
	};
	return createHash("sha256")
		.update(canonical(shape))
		.digest("hex")
		.slice(0, 8);
}

interface ProvisionEntry {
	mode: string;
	script: string;
}

/**
 * Lima re-runs provision scripts on every boot, so each one is wrapped in a
 * marker check keyed to the image hash: changing a layer changes the hash and
 * provisions again.
 */
function guard(hash: string, name: string, body: string): string {
	const marker = `/var/lib/playpen/.provisioned-${hash}-${name}`;
	return [
		"#!/bin/bash",
		"set -euo pipefail",
		`if [ -f ${marker} ]; then exit 0; fi`,
		"mkdir -p /var/lib/playpen",
		body,
		`touch ${marker}`,
	].join("\n");
}

/**
 * Run from the host after every start rather than as a provision script: binds
 * do not survive a reboot, and a clone's instance config is Lima's own
 * resolved yaml, which playpen cannot add provision entries to.
 *
 * Backing storage is on the VM disk, which keeps it off 9p and lets an install
 * survive stop/start.
 */
export function maskScript(mount: string, masks: readonly string[]): string {
	const quoted = masks.map((m) => `'${m.replace(/'/g, `'\\''`)}'`).join(" ");
	return [
		"#!/bin/bash",
		"set -euo pipefail",
		`MOUNT='${mount.replace(/'/g, `'\\''`)}'`,
		// Provisioning runs as root; the guest user has to be able to write the store.
		'owner="$(stat -c "%u:%g" "$MOUNT")"',
		`for rel in ${quoted}; do`,
		'  target="$MOUNT/$rel"',
		'  store="/var/lib/playpen/masks/$rel"',
		'  mkdir -p "$store"',
		'  chown "$owner" "$store"',
		// Creates an empty directory on the host share when the path is absent; a bind mount needs a target.
		'  mkdir -p "$target"',
		'  if ! mountpoint -q "$target"; then',
		'    mount --bind "$store" "$target"',
		"  fi",
		"done",
	].join("\n");
}

function build(
	def: ImageDef,
	opts: ImageOptions,
	mount: string | null,
): Rendered {
	const hash = imageHash(def);
	const provision: ProvisionEntry[] = [];

	// One package transaction for every layer, not one per layer.
	const packages = def.layers.flatMap((l) => l.packages ?? []);
	if (packages.length > 0) {
		provision.push({
			mode: "system",
			script: guard(hash, "packages", def.distro.installCmd(packages)),
		});
	}

	for (const layer of def.layers) {
		if (!layer.script) continue;
		provision.push({
			mode: layer.mode ?? "system",
			script: guard(hash, layer.name, layer.script),
		});
	}

	const env = Object.assign(
		{},
		...def.layers.map((l) => l.env ?? {}),
	) as Record<string, string>;

	const template: Record<string, unknown> = {
		minimumLimaVersion: "2.0.0",
		// Inheriting _default/mounts instead would add a read-only host home.
		base: [def.distro.baseTemplate],
		vmType: "qemu",
		// Lima defaults this to true and copies the host's proxy variables into
		// the guest, rewriting localhost to the guest's host address. The host's
		// proxy is not reachable from inside the fence, and the guest reaches out
		// through a route rather than a setting, so a copied variable can only
		// point programs at something that is not there.
		propagateProxyEnv: false,
		cpus: opts.cpus,
		memory: opts.memory,
		disk: opts.disk,
		// On by default on Linux x86_64; a ~100MB download nothing here uses.
		containerd: { system: false, user: false },
		mounts: mount === null ? [] : [{ location: mount, writable: true }],
		mountType: opts.mountType,
		provision,
		probes: [
			{
				mode: "readiness",
				description: "claude code to be installed",
				script: [
					"#!/bin/bash",
					"set -euo pipefail",
					'if ! timeout 600s bash -c "until command -v claude >/dev/null 2>&1; do sleep 5; done"; then',
					'  echo >&2 "claude is not installed yet"',
					"  exit 1",
					"fi",
				].join("\n"),
				hint: "Claude Code did not install. Check /var/log/cloud-init-output.log in the guest.",
			},
		],
	};

	if (Object.keys(env).length > 0) template.env = env;

	return { template, contentHash: hash };
}

/**
 * A base image belongs to no project, so it is baked with no mount and no
 * masks. Each sandbox writes its own yaml over the clone before first start.
 */
export function renderBase(def: ImageDef, opts: ImageOptions): Rendered {
	return build(def, opts, null);
}

export function render(def: ImageDef, opts: SandboxOptions): Rendered {
	return build(def, opts, opts.mount);
}

/** JSON is valid YAML 1.2, so Lima accepts this as a .yaml without a YAML serializer. */
export function serialize(rendered: Rendered): string {
	return JSON.stringify(rendered.template, null, 2);
}
