import { exists } from "../fs.ts";
import { fencePaths } from "../network/fence.ts";
import { unixConnectAddress } from "../network/socat.ts";
import {
	INSTANCE_PREFIX,
	isPlaypenInstance,
	sandboxFromInstance,
} from "../session/identity.ts";
import {
	attach,
	type CaptureResult,
	type Collected,
	capture,
	captureBuffer,
	feed,
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
 * Quote `value` the way `github.com/mattn/go-shellwords` reads it, which is how
 * Lima splits `$SSH` into a command (pkg/sshutil/sshutil.go). Inside double
 * quotes it treats backslash as an escape and everything else -- spaces, single
 * quotes, backticks, `$(` -- as literal text.
 */
function shellwordsQuote(value: string): string {
	return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/** Quote for the `/bin/sh -c` that ssh runs a ProxyCommand through. */
function shQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `SSH` value that reaches a fenced guest through its control socket.
 *
 * `limactl shell` runs `$SSH` in place of `ssh`, so this is how a session
 * outside the fence connects once Lima's own multiplexed connection is gone.
 * Lima passes `-F /dev/null`, so there is no ssh config file to put this in.
 * The socket path is parsed three times on the way down -- by Lima's splitter,
 * by the shell ssh hands the ProxyCommand to, and by socat's address parser --
 * and is quoted for each.
 */
export function sshThroughControl(controlSocket: string): string {
	const address = shQuote(unixConnectAddress(controlSocket));
	// ssh expands %h, %p and friends in a ProxyCommand and refuses one it does
	// not recognize, so a literal percent has to be doubled.
	const proxy = `ProxyCommand=socat - ${address}`.replaceAll("%", "%%");
	return `ssh -o ${shellwordsQuote(proxy)}`;
}

/**
 * Absent until the sandbox's network helper has published one, and absent
 * entirely for the unfenced base image, so an ordinary Lima connection is what
 * happens when there is no fence to cross.
 */
async function controlSocket(name: string): Promise<string | null> {
	if (!isPlaypenInstance(name)) return null;
	let path: string;
	try {
		path = fencePaths(sandboxFromInstance(name)).control;
	} catch {
		return null;
	}
	return (await exists(path)) ? path : null;
}

/**
 * Never used for `limactl start`, which the helper runs from inside the fence
 * where the ssh port is reachable directly and the control socket does not yet
 * exist.
 */
async function shellEnv(name: string): Promise<NodeJS.ProcessEnv> {
	const socket = await controlSocket(name);
	if (socket === null) return process.env;
	return { ...process.env, SSH: sshThroughControl(socket) };
}

/**
 * Run a script inside a guest, with its stdout captured as bytes so a tar can
 * travel this way. Here rather than at each call site so `limactl` and its
 * argument shape stay in this file.
 */
export async function runScript(
	name: string,
	script: string,
	opts: {
		root?: boolean;
		input?: string | Uint8Array;
		/** Positional parameters for the script, so values never become syntax. */
		args?: readonly string[];
	} = {},
): Promise<Collected> {
	const params = opts.args === undefined ? [] : ["bash", ...opts.args];
	const shell = opts.root
		? ["sudo", "bash", "-c", script, ...params]
		: ["bash", "-c", script, ...params];
	return captureBuffer(
		LIMACTL,
		["shell", name, ...shell],
		{ env: await shellEnv(name) },
		opts.input,
	);
}

export async function shell(
	name: string,
	workdir: string,
	command: readonly string[],
): Promise<number> {
	return attach(LIMACTL, ["shell", `--workdir=${workdir}`, name, ...command], {
		env: await shellEnv(name),
	});
}

/**
 * `limactl shell` with `input` on its stdin, so a tar or a credentials file
 * travels through a pipe rather than argv.
 */
export async function shellInput(
	name: string,
	command: readonly string[],
	input: string | Uint8Array,
): Promise<CaptureResult> {
	return feed(LIMACTL, ["shell", name, ...command], input, {
		env: await shellEnv(name),
	});
}

export function isRunning(instance: Instance | null): boolean {
	return instance?.status === "Running";
}
