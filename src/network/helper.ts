import { type ChildProcess, spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { exists, writeAtomic } from "../fs.ts";
import * as lima from "../lima/client.ts";
import { self } from "../session/proc.ts";
import { attach, capture } from "../sh.ts";
import {
	cliPath,
	type FencePaths,
	fencePaths,
	fenceStatus,
	liveHelper,
	readPolicy,
	removeSocket,
	socatPath,
	writeHelper,
} from "./fence.ts";
import {
	appendJsonLine,
	type LogEntry,
	startGatekeeper,
} from "./gatekeeper.ts";

/**
 * The two processes fence.ts describes, as commands: `__net-helper` outside the
 * network namespace and `__net-inside` within it. Both are routed in cli.ts
 * before citty sees the arguments, like `__complete`: nobody types them.
 *
 * Everything either one prints lands in helper.log, which is the only place a
 * failure to boot can be read afterwards.
 */

/** Cheap: a `limactl list` is a status file read, not a call into the guest. */
const POLL_MS = 3_000;

const GUEST_PROXY_PORT = 1080;

function say(text: string): void {
	console.error(`[${new Date().toISOString()}] ${text}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A limactl that cannot answer is read as "gone" rather than retried: the
 * consequence is that the gatekeeper shuts down and the sandbox loses egress
 * until the next `playpen start`, which is the direction to fail in.
 */
async function vmRunning(instance: string): Promise<boolean> {
	try {
		return lima.isRunning(await lima.get(instance));
	} catch {
		return false;
	}
}

async function waitWhileRunning(instance: string): Promise<void> {
	while (await vmRunning(instance)) await sleep(POLL_MS);
}

/** Appends are serialized so the log keeps the order the verdicts happened in. */
function jsonLineAppender(path: string): (entry: LogEntry) => void {
	let tail: Promise<void> = Promise.resolve();
	return (entry) => {
		tail = tail
			.then(() => appendJsonLine(path, entry))
			.catch((err: unknown) => say(`warning: could not write ${path}: ${err}`));
	};
}

function socatListen(path: string, target: string): ChildProcess {
	return spawn(
		"socat",
		[`UNIX-LISTEN:${socatPath(path)},fork,unlink-early,mode=600`, target],
		{ stdio: "inherit" },
	);
}

export async function runHelper(
	sandbox: string,
	instance: string,
): Promise<number> {
	const paths = fencePaths(sandbox);
	const policy = await readPolicy(sandbox);

	const running = await liveHelper(sandbox);
	if (running !== null) {
		say(`a helper for ${sandbox} is already running (pid ${running.pid})`);
		return 1;
	}

	const state = await fenceStatus(sandbox, instance);
	if (state === "unsealed") {
		say(`${instance} is already running outside the fence`);
		say(`  stop it first: playpen stop, then playpen start`);
		return 1;
	}

	// Reattaching to a VM whose own qemu still holds the namespace open. Egress
	// comes back only if the socats inside it outlived the last helper; if they
	// did not, nothing out here can reach into the namespace to replace them and
	// the fix is `playpen stop` followed by `playpen start`.
	const reattach = state !== "stopped";
	if (reattach) say(`${instance} is already fenced; reattaching`);

	const gatekeeper = await startGatekeeper({
		policy,
		log: jsonLineAppender(paths.gatekeeperLog),
	});
	say(`gatekeeper listening on 127.0.0.1:${gatekeeper.port}`);

	const relay = socatListen(paths.egress, `TCP:127.0.0.1:${gatekeeper.port}`);

	let inside: ChildProcess | null = null;
	if (!reattach) {
		await unlink(paths.control).catch(() => {});
		await unlink(paths.ready).catch(() => {});
		inside = spawn(
			"bwrap",
			[
				"--unshare-net",
				"--dev-bind",
				"/",
				"/",
				"--die-with-parent",
				"--",
				process.execPath,
				cliPath(),
				"__net-inside",
				sandbox,
				instance,
			],
			{ stdio: "inherit" },
		);
	}

	const owner = await self();
	await writeHelper(sandbox, {
		...owner,
		gatekeeperPort: gatekeeper.port,
		ready: false,
	});

	let stopping = false;
	const teardown = async (vmGone: boolean): Promise<void> => {
		if (stopping) return;
		stopping = true;
		await gatekeeper.close().catch(() => {});
		relay.kill("SIGKILL");
		await removeSocket(paths.egress);
		// Left in place otherwise: the inside half still owns it, and a reattach
		// needs it to keep `limactl shell` working.
		if (vmGone) await removeSocket(paths.control);
		await unlink(paths.helper).catch(() => {});
	};
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.on(signal, () => {
			void teardown(false).then(() => process.exit(0));
		});
	}

	if (inside !== null && !(await insideCameUp(inside, paths))) {
		say(`${instance} did not come up inside the fence`);
		await teardown(false);
		return 1;
	}

	await writeHelper(sandbox, {
		...owner,
		gatekeeperPort: gatekeeper.port,
		ready: true,
	});
	say(`${instance} is up and fenced`);

	await waitWhileRunning(instance);
	say(`${instance} is no longer running; shutting the fence down`);
	await teardown(true);
	return 0;
}

/**
 * The inside half signals through a file rather than its stdout, so the answer
 * is still there whenever the helper gets around to looking.
 */
async function insideCameUp(
	inside: ChildProcess,
	paths: FencePaths,
): Promise<boolean> {
	let exited = false;
	inside.on("exit", () => {
		exited = true;
	});
	for (;;) {
		if (await exists(paths.ready)) return true;
		// Checked after the file, so a ready written just before the process went
		// away is still believed.
		if (exited) return false;
		await sleep(500);
	}
}

export async function runInside(
	sandbox: string,
	instance: string,
): Promise<number> {
	const paths = fencePaths(sandbox);

	// The address the guest is pointed at: qemu's user-mode network maps
	// 192.168.5.2 to this namespace's loopback.
	const egress = spawn(
		"socat",
		[
			`TCP-LISTEN:${GUEST_PROXY_PORT},fork,reuseaddr,bind=127.0.0.1`,
			`UNIX-CONNECT:${socatPath(paths.egress)}`,
		],
		{ stdio: "inherit" },
	);

	const code = await attach("limactl", ["start", "--tty=false", instance]);
	if (code !== 0) {
		egress.kill("SIGKILL");
		return code;
	}

	const port = await sshPort(instance);
	const control = socatListen(paths.control, `TCP:127.0.0.1:${port}`);
	await writeAtomic(paths.ready, `${port}\n`);

	await waitWhileRunning(instance);
	control.kill("SIGKILL");
	egress.kill("SIGKILL");
	return 0;
}

/** Reassigned on every `limactl start`, so it is read after the VM is up. */
async function sshPort(instance: string): Promise<number> {
	const { code, stdout, stderr } = await capture("limactl", [
		"list",
		"--format",
		"{{.SSHLocalPort}}",
		instance,
	]);
	const port = Number(stdout.trim());
	if (code !== 0 || !Number.isInteger(port) || port <= 0) {
		throw new Error(
			`cannot read the ssh port of ${instance}: ${stderr.trim()}`,
		);
	}
	return port;
}
