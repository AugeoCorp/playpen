import { INSTANCE_PREFIX } from "../session/identity.ts";
import {
	attach,
	type Collected,
	capture,
	captureBuffer,
	mustSucceed,
} from "../sh.ts";

/** Subset of `limactl list --format json` we rely on. */
export interface Instance {
	name: string;
	status: string;
	dir: string;
	vmType: string;
	cpus: number;
	memory: number;
	disk: number;
}

const LIMACTL = "limactl";

function parseInstance(value: unknown): Instance | null {
	if (typeof value !== "object" || value === null) return null;
	const o = value as Record<string, unknown>;
	if (typeof o.name !== "string") return null;
	return {
		name: o.name,
		status: typeof o.status === "string" ? o.status : "Unknown",
		dir: typeof o.dir === "string" ? o.dir : "",
		vmType: typeof o.vmType === "string" ? o.vmType : "",
		cpus: typeof o.cpus === "number" ? o.cpus : 0,
		memory: typeof o.memory === "number" ? o.memory : 0,
		disk: typeof o.disk === "number" ? o.disk : 0,
	};
}

/**
 * `limactl list --format json` emits one JSON object per line, not an array,
 * so this parses line-wise and skips anything unrecognizable rather than
 * failing the whole listing over one odd row. Throws when limactl itself fails.
 */
export async function list(): Promise<Instance[]> {
	const { stdout } = mustSucceed(
		"limactl list",
		await capture(LIMACTL, ["list", "--format", "json"]),
	);
	return stdout
		.split("\n")
		.filter((line) => line.trim() !== "")
		.flatMap((line) => {
			try {
				const parsed = parseInstance(JSON.parse(line));
				return parsed ? [parsed] : [];
			} catch {
				return [];
			}
		});
}

export async function get(name: string): Promise<Instance | null> {
	return (await list()).find((i) => i.name === name) ?? null;
}

/**
 * Only used to bake a base. A healthy bake takes ~75s with KVM, ~10 minutes
 * without; `--timeout` is what ends one whose provisioning has failed, so it
 * is not raised any further than that.
 */
export async function createAndStart(
	name: string,
	templatePath: string,
): Promise<void> {
	// --tty=false: limactl otherwise prompts to edit the template.
	const code = await attach(LIMACTL, [
		"start",
		`--name=${name}`,
		"--tty=false",
		"--timeout=20m",
		templatePath,
	]);
	if (code !== 0)
		throw new Error(`limactl start failed for ${name} (exit ${code})`);
}

/**
 * Near-free on a reflinking filesystem. `clone` refuses a running source, and
 * without --tty=false it prompts and then starts the copy.
 */
export async function clone(source: string, target: string): Promise<void> {
	assertOurs("clone into", target);
	mustSucceed(
		"limactl clone",
		await capture(LIMACTL, ["clone", "--tty=false", source, target]),
	);
}

export async function start(name: string): Promise<void> {
	const code = await attach(LIMACTL, ["start", "--tty=false", name]);
	if (code !== 0)
		throw new Error(`limactl start failed for ${name} (exit ${code})`);
}

/**
 * Checked here rather than trusting callers to have gone through
 * `instanceName()`: these operations destroy VMs, so the check belongs at the
 * dangerous boundary.
 */
function assertOurs(operation: string, name: string): void {
	if (!name.startsWith(INSTANCE_PREFIX)) {
		throw new Error(
			`refusing to ${operation} "${name}": not a playpen instance (must start with "${INSTANCE_PREFIX}")`,
		);
	}
}

export async function stop(name: string, force = false): Promise<void> {
	assertOurs("stop", name);
	const args = force ? ["stop", "-f", name] : ["stop", name];
	mustSucceed("limactl stop", await capture(LIMACTL, args));
}

export async function remove(name: string): Promise<void> {
	assertOurs("delete", name);
	mustSucceed("limactl delete", await capture(LIMACTL, ["delete", "-f", name]));
}

/**
 * Run a script inside a guest, with its stdout captured as bytes so a tar can
 * travel this way. Here rather than at each call site so `limactl` and its
 * argument shape stay in this file.
 */
export function runScript(
	name: string,
	script: string,
	opts: { root?: boolean; input?: string | Uint8Array } = {},
): Promise<Collected> {
	const shell = opts.root
		? ["sudo", "bash", "-c", script]
		: ["bash", "-c", script];
	return captureBuffer(LIMACTL, ["shell", name, ...shell], {}, opts.input);
}

export function shell(
	name: string,
	workdir: string,
	command: readonly string[],
): Promise<number> {
	return attach(LIMACTL, ["shell", `--workdir=${workdir}`, name, ...command]);
}

export function isRunning(instance: Instance | null): boolean {
	return instance?.status === "Running";
}
