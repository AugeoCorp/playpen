import { type ChildProcess, spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { exists, readAppended, sizeOf, writeAtomic } from "../fs.ts";
import * as lima from "../lima/client.ts";
import { self } from "../session/proc.ts";
import { attach, capture } from "../sh.ts";
import { sleep } from "../time.ts";
import {
	cliPath,
	type FencePaths,
	fencePaths,
	fenceStatus,
	liveHelper,
	policyStamp,
	readPolicy,
	removeSocket,
	writeHelper,
} from "./fence.ts";
import {
	appendJsonLine,
	type LogEntry,
	startGatekeeper,
} from "./gatekeeper.ts";
import { NO_EGRESS_ADVICE, type Policy, PROBE_HOST } from "./policy.ts";
import {
	spawnSocat,
	tcpListenAddress,
	unixConnectAddress,
	unixListenAddress,
} from "./socat.ts";

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

/**
 * How long the guest gets to answer the egress probe. tun2proxy's unit retries
 * every 2 s, so a guest whose tunnel is merely slow to come up is well inside
 * this; one that is still silent at the end of it is broken, not slow.
 */
const PROBE_WINDOW_MS = 60_000;

function say(text: string): void {
	console.error(`[${new Date().toISOString()}] ${text}`);
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

/**
 * policy.json is written whole, by rename, so a policy that will not parse is
 * a corrupt file rather than a half-written one. The sandbox loses its network
 * until the next `playpen start` instead of keeping a policy nobody can read.
 */
async function reloadPolicy(sandbox: string): Promise<Policy> {
	try {
		const policy = await readPolicy(sandbox);
		say(
			`policy.json was rewritten: ${policy.allow.length} entries, mode ${policy.mode}`,
		);
		return policy;
	} catch (err) {
		say(
			`policy.json is unreadable (${err}); denying everything until the next start`,
		);
		return { allow: [], mode: "enforce" };
	}
}

/**
 * Waits for the VM to go away, keeping the gatekeeper's policy in step with
 * the file `playpen start` writes -- which is how a sandbox that is already up
 * picks up a tightened allow list.
 */
async function serveWhileRunning(
	sandbox: string,
	instance: string,
	swap: (policy: Policy) => void,
): Promise<void> {
	let stamp = await policyStamp(sandbox);
	while (await vmRunning(instance)) {
		await sleep(POLL_MS);
		const now = await policyStamp(sandbox);
		if (now === stamp) continue;
		stamp = now;
		swap(await reloadPolicy(sandbox));
	}
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
	return spawnSocat(unixListenAddress(path), target);
}

export async function runHelper(
	sandbox: string,
	instance: string,
): Promise<number> {
	const paths = fencePaths(sandbox);
	let policy = await readPolicy(sandbox);

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

	const logFrom = await sizeOf(paths.gatekeeperLog);
	const gatekeeper = await startGatekeeper({
		policy: () => policy,
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
		egress: false,
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

	const egress = await guestReachesGatekeeper(instance, paths, logFrom);
	await writeHelper(sandbox, {
		...owner,
		gatekeeperPort: gatekeeper.port,
		ready: true,
		egress,
	});
	say(`${instance} is up and fenced`);
	if (egress) {
		say(`the guest reached the gatekeeper`);
	} else {
		// Still ready, and the VM keeps running: it is fenced and usable, which
		// is what a sandbox with a broken tunnel needs in order to be repaired.
		say(`this sandbox has no network`);
		for (const line of NO_EGRESS_ADVICE) say(`  ${line}`);
	}

	await serveWhileRunning(sandbox, instance, (next) => {
		policy = next;
	});
	say(`${instance} is no longer running; shutting the fence down`);
	await teardown(true);
	return 0;
}

/**
 * Does the guest's own traffic reach the gatekeeper? Everything else the helper
 * knows is from out here, where a guest whose tun2proxy died looks exactly like
 * a healthy one.
 *
 * The request is driven from outside the fence over Lima's control path, so a
 * sandbox that passes has both directions working. `PROBE_HOST` is answered by
 * the policy and never dialed, so this costs no connection and needs no allow
 * entry; its refusal in the log is the whole signal. `--noproxy` keeps any
 * proxy variable in the guest out of it: only the route can carry this.
 */
async function guestReachesGatekeeper(
	instance: string,
	paths: FencePaths,
	logFrom: number,
): Promise<boolean> {
	const deadline = Date.now() + PROBE_WINDOW_MS;
	for (;;) {
		await lima
			.runScript(
				instance,
				`curl -s -o /dev/null --max-time 15 --noproxy '*' http://${PROBE_HOST}/ || true`,
			)
			.catch((err: unknown) =>
				say(`warning: could not probe the guest: ${err}`),
			);
		if (await probeLogged(paths.gatekeeperLog, logFrom)) return true;
		if (Date.now() > deadline) return false;
		await sleep(2_000);
	}
}

/** Only what this helper's own gatekeeper appended: a `probe` line from the
 * sandbox's last run would otherwise pass for this one's. */
async function probeLogged(path: string, from: number): Promise<boolean> {
	const { text } = await readAppended(path, from);
	for (const line of text.split("\n")) {
		if (line === "") continue;
		try {
			if ((JSON.parse(line) as LogEntry).verdict === "probe") return true;
		} catch {
			// A half-written last line; the next pass reads it whole.
		}
	}
	return false;
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
	const egress = spawnSocat(
		tcpListenAddress(GUEST_PROXY_PORT),
		unixConnectAddress(paths.egress),
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
