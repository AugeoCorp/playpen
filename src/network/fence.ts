import { type ChildProcess, spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	open,
	readFile,
	readlink,
	stat,
	unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { dataDir, limaHome } from "../config.ts";
import { readAppended, sizeOf, writeAtomic } from "../fs.ts";
import { describeIssue } from "../issue.ts";
import { assertSandboxName } from "../session/identity.ts";
import { isLive, ownerSchema } from "../session/proc.ts";
import { networkMode } from "../session/projectconfig.ts";
import { capture } from "../sh.ts";
import { sleep } from "../time.ts";
import { isPort } from "./names.ts";
import { isEnvName, type Policy, parseSecretHost } from "./policy.ts";

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
	assertSandboxName(sandbox);
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

/**
 * `mkdir`'s own `mode` is only applied on creation, not to a directory that
 * already exists, so an existing 0o755 directory from before this fix needs
 * the explicit `chmod` too.
 */
async function ensureFenceDir(sandbox: string): Promise<void> {
	const { dir } = fencePaths(sandbox);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
}

const PORT_RANGE = "must be a port from 1 to 65535";

const port = z
	.number({ error: PORT_RANGE })
	.refine(isPort, { error: PORT_RANGE });

const portForward = z.object(
	{ host: port, guest: port },
	{ error: "must be { host, guest }" },
);

const helperRecord = ownerSchema.extend({
	gatekeeperPort: z.number(),
	/** False between the helper starting and the guest first answering. */
	ready: z.boolean(),
	/**
	 * Whether the guest's own request for `PROBE_HOST` reached the gatekeeper.
	 * The fence being up says nothing about this: the guest's tun2proxy can be
	 * dead and everything out here still look healthy.
	 */
	egress: z.boolean(),
	/**
	 * `policyStamp` of the policy.json the gatekeeper is deciding with, so
	 * `bringUp` can tell a rewritten policy has been applied rather than
	 * assume it. Empty until the first policy is loaded.
	 */
	policy: z.string().default(""),
	/**
	 * Entries of the policy's `ports` with nothing listening at the guest's end,
	 * so `playpen start` can name them. Absent from a helper older than
	 * `ports`, and until the guest has first been asked.
	 */
	unboundPorts: z.array(portForward).optional(),
});

export type HelperRecord = z.infer<typeof helperRecord>;

export async function writeHelper(
	sandbox: string,
	record: HelperRecord,
): Promise<void> {
	await writeAtomic(fencePaths(sandbox).helper, `${JSON.stringify(record)}\n`);
}

async function readHelper(sandbox: string): Promise<HelperRecord | null> {
	try {
		const raw = await readFile(fencePaths(sandbox).helper, "utf8");
		return helperRecord.parse(JSON.parse(raw));
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

/** Returns whether this changed what was on disk, so a caller can say that a
 * sandbox which is already running has a new policy coming. */
export async function writePolicy(
	sandbox: string,
	policy: Policy,
): Promise<boolean> {
	const paths = fencePaths(sandbox);
	await ensureFenceDir(sandbox);
	const next = `${JSON.stringify(policy)}\n`;
	const previous = await readFile(paths.policy, "utf8").catch(() => "");
	await writeAtomic(paths.policy, next);
	return next !== previous;
}

/**
 * A value that changes whenever policy.json is rewritten, for the helper
 * polling it while a sandbox runs. The size goes in alongside the mtime
 * because a filesystem with coarse timestamps can date two writes the same.
 * An absent file stamps as "", which is a change once one appears.
 */
export async function policyStamp(sandbox: string): Promise<string> {
	try {
		const { mtimeMs, size } = await stat(fencePaths(sandbox).policy);
		return `${mtimeMs}:${size}`;
	} catch {
		return "";
	}
}

const secretGrant = z.object(
	{
		env: z
			.string({ error: "must be an environment variable name" })
			.refine(isEnvName, { error: "must be an environment variable name" }),
		hosts: z
			.array(
				z
					.string({ error: "must be a hostname" })
					.refine((host) => parseSecretHost(host) !== null, {
						error: "must be a hostname without a port",
					}),
				{ error: "must be an array of hostnames" },
			)
			.min(1, { error: "must name at least one host" }),
	},
	{ error: "must be { env, hosts }" },
);

const policyFile = z.object(
	{
		allow: z.array(z.string({ error: "must be a string" }), {
			error: "must be an array of strings",
		}),
		mode: networkMode,
		/**
		 * Both numbers are printed into a root script in the guest, so a
		 * hand-edited policy.json must not get anything else in.
		 */
		ports: z.array(portForward, {
			error: "must be an array of { host, guest }",
		}),
		secrets: z.array(secretGrant, {
			error: "must be an array of { env, hosts }",
		}),
	},
	{ error: "must hold a JSON object" },
);

/**
 * Throws rather than falling back to a default: an unreadable policy must stop
 * the sandbox coming up, never open it.
 */
export async function readPolicy(sandbox: string): Promise<Policy> {
	const path = fencePaths(sandbox).policy;
	const result = policyFile.safeParse(JSON.parse(await readFile(path, "utf8")));
	if (!result.success) throw new Error(describeIssue(result.error, path));
	return result.data;
}

export type FenceState =
	/** qemu is in another network namespace and a ready helper is feeding it. */
	| "sealed"
	/** Fenced with a ready helper, but the guest could not reach it. */
	| "sealed-no-egress"
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
	if (facts.helper?.ready !== true) return "sealed-no-gatekeeper";
	return facts.helper.egress ? "sealed" : "sealed-no-egress";
}

async function netNamespace(pid: number): Promise<string | null> {
	try {
		return await readlink(`/proc/${pid}/ns/net`);
	} catch {
		return null;
	}
}

/**
 * Whether a `/proc/<pid>/cmdline` (NUL-separated argv) belongs to qemu. The
 * pid file outlives the process it names, and the kernel recycles pids, so a
 * pid that now belongs to an unrelated process -- another program entirely,
 * or a qemu for a different instance after a reboot -- must not be trusted as
 * "our qemu is running".
 */
export function looksLikeQemu(cmdline: string): boolean {
	const argv0 = cmdline.split("\0")[0] ?? "";
	return basename(argv0).startsWith("qemu-system");
}

/** Lima's own file, and it outlives the process it names, so nothing here
 * trusts the number beyond asking /proc whether it is still qemu. */
async function qemuPid(instance: string): Promise<number | null> {
	let raw: string;
	try {
		raw = await readFile(join(limaHome(), instance, "qemu.pid"), "utf8");
	} catch {
		return null;
	}
	const pid = Number(raw.trim());
	if (!Number.isInteger(pid) || pid <= 0) return null;
	let cmdline: string;
	try {
		cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
	} catch {
		return null;
	}
	return looksLikeQemu(cmdline) ? pid : null;
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
	await ensureFenceDir(sandbox);
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

async function drain(
	path: string,
	from: number,
	sink: (text: string) => void,
): Promise<number> {
	const { text, end } = await readAppended(path, from);
	if (text !== "") sink(text);
	return end;
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
 * How long a running helper gets to pick up a rewritten policy.json. It polls
 * every few seconds (`POLL_MS` in helper.ts), so this is several polls.
 */
const APPLY_WINDOW_MS = 15_000;

/**
 * Start the sandbox VM inside its fence and return once the guest answers.
 *
 * Returns without spawning anything when a ready helper is already running for
 * this sandbox, since a second one would fight it for the egress socket. The
 * policy is written either way: it is the running helper's source of truth,
 * which it re-reads, so this is how a sandbox that is already up is
 * retightened -- and the call returns only once the helper reports the new
 * policy applied, or throws, so "updated" is never said of a policy that is
 * not yet deciding anything. Connections already open stay open either way;
 * the policy decides new ones.
 */
export async function bringUp(opts: BringUpOptions): Promise<void> {
	const { sandbox, instance } = opts;
	const changed = await writePolicy(sandbox, opts.policy);
	const stamp = await policyStamp(sandbox);

	const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
	let state = await fenceStatus(sandbox, instance);
	if (state === "stopped")
		state = await afterEarlierHelper(sandbox, instance, deadline);
	if (state === "sealed" || state === "sealed-no-egress") {
		if (changed) {
			await applied(sandbox, stamp);
			opts.log(`network policy updated for new connections\n`);
		}
		return;
	}

	const paths = fencePaths(sandbox);
	let offset = await sizeOf(paths.helperLog);
	const child = await spawnHelper(sandbox, instance);

	let exit: number | null = null;
	child.on("exit", (code) => {
		exit = code ?? 1;
	});

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

/**
 * How long the VM may read stopped while an earlier helper still runs. One
 * whose VM is gone notices on its next poll (`POLL_MS` in helper.ts), and one
 * that is booting has qemu running within seconds, so this is several polls.
 */
const STOPPED_WINDOW_MS = 30_000;

/**
 * An earlier helper still running while the VM reads stopped is one of two
 * things: a helper whose VM just went away, whose record says ready until its
 * next poll, or one still booting the VM for a `playpen start` that was
 * interrupted. A
 * new helper would refuse to run beside either, and the earlier one's record
 * would pass for its own, so this waits until it has exited or its VM is up,
 * and returns the state the fence settled in.
 */
async function afterEarlierHelper(
	sandbox: string,
	instance: string,
	deadline: number,
): Promise<FenceState> {
	let stoppedSince = Date.now();
	for (;;) {
		const state = await fenceStatus(sandbox, instance);
		if (state === "sealed" || state === "sealed-no-egress") return state;
		const helper = await liveHelper(sandbox);
		if (helper === null || state === "unsealed") return state;
		if (state !== "stopped") stoppedSince = Date.now();
		const now = Date.now();
		if (now - stoppedSince > STOPPED_WINDOW_MS || now > deadline) {
			throw new Error(
				`an earlier network helper for ${sandbox} (pid ${helper.pid}) has neither exited nor brought its VM up; see ${fencePaths(sandbox).helperLog}\n` +
					`  if no other playpen is starting this sandbox, stop it with: kill ${helper.pid}`,
			);
		}
		await sleep(250);
	}
}

async function applied(sandbox: string, stamp: string): Promise<void> {
	const deadline = Date.now() + APPLY_WINDOW_MS;
	while ((await liveHelper(sandbox))?.policy !== stamp) {
		if (Date.now() > deadline) {
			throw new Error(
				`the running sandbox has not picked up the new network policy; see ${fencePaths(sandbox).helperLog}`,
			);
		}
		await sleep(500);
	}
}

/**
 * Kill what a fence leaves behind once its VM is gone: the inside socats,
 * which outlive a killed helper on purpose so the next one can reattach, and
 * the inside half itself. Found by argv, since a killed helper left no other
 * record of them: each names one of this sandbox's socket paths or the
 * sandbox itself, so another sandbox's fence is never touched. Best effort,
 * like `removeSocket`: a process already gone is the outcome wanted.
 */
export async function killFenceLeftovers(sandbox: string): Promise<void> {
	const paths = fencePaths(sandbox);
	for (const pattern of [
		paths.egress,
		paths.control,
		`__net-inside ${sandbox} `,
	])
		await capture("pkill", ["-9", "-f", pattern]);
}

/** Best effort: a socket file that is already gone is the outcome wanted. */
export async function removeSocket(path: string): Promise<void> {
	await unlink(path).catch(() => {});
}
