import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, open, readFile, readlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, limaHome } from "../config.ts";
import { writeAtomic } from "../fs.ts";
import { isLive, type Owner } from "../session/proc.ts";
import type { Policy } from "./policy.ts";

/**
 * The fence: a network namespace with no route out, holding one sandbox VM.
 *
 * Two processes make it. The *helper* runs outside and owns the gatekeeper
 * (gatekeeper.ts) plus a relay listening on `egress.sock`; the *inside*
 * process runs under `bwrap --unshare-net`, starts the VM there, and relays
 * the fence's `127.0.0.1:1080` back out over that socket. A unix socket
 * crosses a network namespace and a TCP connection does not, which is the
 * whole mechanism. The inside half also publishes the VM's ssh port on
 * `control.sock`, so `limactl shell` reaches the guest from outside without
 * joining the namespace.
 *
 * Neither process holds the namespace open: the VM's own qemu and hostagent
 * do, because bwrap runs without `--unshare-pid` (with it, Lima reports a
 * healthy instance as Broken). Killing either process leaves the VM running
 * and still fenced, which is what `fenceStatus` distinguishes.
 *
 * This file owns the layout and the outside view of it; helper.ts is the two
 * processes themselves.
 */

/** Same shape leases.ts requires, and for the same reason: it becomes a path. */
const SANDBOX_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface FencePaths {
	dir: string;
	/** Bound outside, connected to from within the fence. */
	egress: string;
	/** Bound inside, connected to from outside for `limactl shell`. */
	control: string;
	helper: string;
	policy: string;
	gatekeeperLog: string;
	helperLog: string;
	/** Written by the inside half once the VM is up; holds its ssh port. */
	ready: string;
}

export function fencePaths(sandbox: string): FencePaths {
	if (!SANDBOX_NAME.test(sandbox)) {
		throw new Error(`invalid sandbox name: ${JSON.stringify(sandbox)}`);
	}
	const dir = join(dataDir(), "net", sandbox);
	return {
		dir,
		egress: join(dir, "egress.sock"),
		control: join(dir, "control.sock"),
		helper: join(dir, "helper.json"),
		policy: join(dir, "policy.json"),
		gatekeeperLog: join(dir, "gatekeeper.log"),
		helperLog: join(dir, "helper.log"),
		ready: join(dir, "ready"),
	};
}

export interface HelperRecord extends Owner {
	gatekeeperPort: number;
	/** False between the helper starting and the guest first answering. */
	ready: boolean;
}

export async function writeHelper(
	sandbox: string,
	record: HelperRecord,
): Promise<void> {
	await writeAtomic(fencePaths(sandbox).helper, `${JSON.stringify(record)}\n`);
}

async function readHelper(sandbox: string): Promise<HelperRecord | null> {
	try {
		const raw = await readFile(fencePaths(sandbox).helper, "utf8");
		return JSON.parse(raw) as HelperRecord;
	} catch {
		return null;
	}
}

/** The helper recorded for this sandbox, if its process is still that process. */
export async function liveHelper(
	sandbox: string,
): Promise<HelperRecord | null> {
	const record = await readHelper(sandbox);
	if (record === null) return null;
	return (await isLive(record)) ? record : null;
}

export async function writePolicy(
	sandbox: string,
	policy: Policy,
): Promise<void> {
	const paths = fencePaths(sandbox);
	await mkdir(paths.dir, { recursive: true });
	await writeAtomic(paths.policy, `${JSON.stringify(policy)}\n`);
}

/**
 * Throws rather than falling back to a default: an unreadable policy must stop
 * the sandbox coming up, never open it.
 */
export async function readPolicy(sandbox: string): Promise<Policy> {
	const path = fencePaths(sandbox).policy;
	const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Policy>;
	const { allow, mode } = parsed;
	if (!Array.isArray(allow) || allow.some((e) => typeof e !== "string")) {
		throw new Error(`${path}: \`allow\` must be an array of strings`);
	}
	if (mode !== "enforce" && mode !== "log") {
		throw new Error(`${path}: \`mode\` must be "enforce" or "log"`);
	}
	return { allow, mode };
}

export type FenceState =
	/** qemu is in another network namespace and a ready helper is feeding it. */
	| "sealed"
	/** qemu is still fenced, but nothing is answering on the egress socket. */
	| "sealed-no-gatekeeper"
	/** qemu is running in our own namespace: started outside the fence. */
	| "unsealed"
	| "stopped";

export interface FenceFacts {
	/** qemu's network namespace, or null when no qemu is running. */
	guestNetNs: string | null;
	ourNetNs: string;
	/** The live helper for this sandbox, or null. */
	helper: HelperRecord | null;
}

export function classifyFence(facts: FenceFacts): FenceState {
	if (facts.guestNetNs === null) return "stopped";
	if (facts.guestNetNs === facts.ourNetNs) return "unsealed";
	return facts.helper?.ready === true ? "sealed" : "sealed-no-gatekeeper";
}

async function netNamespace(pid: number): Promise<string | null> {
	try {
		return await readlink(`/proc/${pid}/ns/net`);
	} catch {
		return null;
	}
}

/** Lima's own file, and it outlives the process it names, so nothing here
 * trusts the number beyond asking /proc about it. */
async function qemuPid(instance: string): Promise<number | null> {
	let raw: string;
	try {
		raw = await readFile(join(limaHome(), instance, "qemu.pid"), "utf8");
	} catch {
		return null;
	}
	const pid = Number(raw.trim());
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function fenceStatus(
	sandbox: string,
	instance: string,
): Promise<FenceState> {
	const ourNetNs = await netNamespace(process.pid);
	if (ourNetNs === null) {
		throw new Error(`cannot read /proc/${process.pid}/ns/net`);
	}
	const pid = await qemuPid(instance);
	return classifyFence({
		guestNetNs: pid === null ? null : await netNamespace(pid),
		ourNetNs,
		helper: await liveHelper(sandbox),
	});
}

/**
 * socat splits an address on `:` and `,`, so any of those in a path has to be
 * escaped before it becomes part of one. Verified against socat 1.8.0.
 */
export function socatPath(path: string): string {
	return path.replace(/[\\:,!'"]/g, "\\$&");
}

export function cliPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
}

/**
 * Detached with its output in helper.log, because it has to outlive the
 * `playpen start` that asked for it: the sandbox stays up after the command
 * that created it returns.
 */
async function spawnHelper(
	sandbox: string,
	instance: string,
): Promise<ChildProcess> {
	const paths = fencePaths(sandbox);
	await mkdir(paths.dir, { recursive: true });
	const log = await open(paths.helperLog, "a");
	try {
		const child = spawn(
			process.execPath,
			[cliPath(), "__net-helper", sandbox, instance],
			{ detached: true, stdio: ["ignore", log.fd, log.fd] },
		);
		child.unref();
		return child;
	} finally {
		await log.close();
	}
}

async function logSize(path: string): Promise<number> {
	try {
		const handle = await open(path, "r");
		try {
			return (await handle.stat()).size;
		} finally {
			await handle.close();
		}
	} catch {
		return 0;
	}
}

/** Reads what has been appended since `from` and returns the new end. */
async function drain(
	path: string,
	from: number,
	sink: (text: string) => void,
): Promise<number> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "r");
	} catch {
		return from;
	}
	try {
		const { size } = await handle.stat();
		if (size <= from) return from;
		const buffer = Buffer.alloc(size - from);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
		sink(buffer.subarray(0, bytesRead).toString("utf8"));
		return from + bytesRead;
	} finally {
		await handle.close();
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BringUpOptions {
	sandbox: string;
	instance: string;
	policy: Policy;
	/** Where helper.log goes while the caller waits; usually stderr. */
	log: (text: string) => void;
	timeoutMs?: number;
}

/**
 * Start the sandbox VM inside its fence and return once the guest answers.
 *
 * Returns without spawning anything when a ready helper is already running for
 * this sandbox, since a second one would fight it for the egress socket.
 */
export async function bringUp(opts: BringUpOptions): Promise<void> {
	const { sandbox, instance } = opts;
	await writePolicy(sandbox, opts.policy);

	if ((await fenceStatus(sandbox, instance)) === "sealed") {
		opts.log(`warning: ${sandbox} is already running fenced; leaving it\n`);
		return;
	}

	const paths = fencePaths(sandbox);
	let offset = await logSize(paths.helperLog);
	const child = await spawnHelper(sandbox, instance);

	let exit: number | null = null;
	child.on("exit", (code) => {
		exit = code ?? 1;
	});

	const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
	for (;;) {
		offset = await drain(paths.helperLog, offset, opts.log);
		if ((await liveHelper(sandbox))?.ready === true) return;
		if (exit !== null) {
			throw new Error(
				`the network helper for ${sandbox} exited ${exit}; see ${paths.helperLog}`,
			);
		}
		if (Date.now() > deadline) {
			throw new Error(
				`the network helper for ${sandbox} did not come up; see ${paths.helperLog}`,
			);
		}
		await sleep(250);
	}
}

/** Best effort: a socket that is already gone is the outcome we wanted. */
export async function removeSocket(path: string): Promise<void> {
	await unlink(path).catch(() => {});
}
