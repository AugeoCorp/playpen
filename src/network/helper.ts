import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists, readAppended, sizeOrZero, writeAtomic } from "../fs.ts";
import * as lima from "../lima/client.ts";
import { self } from "../session/proc.ts";
import { attach, capture } from "../sh.ts";
import { sleep } from "../time.ts";
import {
	cliPath,
	type FencePaths,
	fencePaths,
	fenceStatus,
	type HelperRecord,
	killFenceLeftovers,
	liveHelper,
	type Mounts,
	maskKind,
	policyStamp,
	readPolicy,
	removeSocket,
	underMaskedDir,
	writeHelper,
} from "./fence.ts";
import {
	appendJsonLine,
	type LogEntry,
	startGatekeeper,
} from "./gatekeeper.ts";
import {
	DENY_HOST,
	HOST_ALIAS,
	NO_EGRESS_ADVICE,
	type Policy,
	type PortForward,
	PROBE_HOST,
} from "./policy.ts";
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
		return { allow: [], mode: "enforce", ports: [], secrets: [] };
	}
}

/**
 * Waits for the VM to go away, keeping the gatekeeper's policy in step with
 * the file `playpen start` writes -- which is how a sandbox that is already up
 * picks up a tightened allow list. `stamp` is the file the current policy
 * came from; `swap` is told the new stamp with the policy so it can report
 * what is now applied.
 */
async function serveWhileRunning(
	sandbox: string,
	instance: string,
	stamp: string,
	swap: (policy: Policy, stamp: string) => Promise<void>,
): Promise<void> {
	while (await vmRunning(instance)) {
		await sleep(POLL_MS);
		const now = await policyStamp(sandbox);
		if (now === stamp) continue;
		stamp = now;
		await swap(await reloadPolicy(sandbox), stamp);
	}
}

/**
 * Directories holding the host resolver's sockets, hidden inside the fence.
 * A socket file crosses a network namespace -- that is what egress.sock
 * relies on -- so a lookup from in here that reached systemd-resolved over
 * its socket would leave the fence. Only the ones present on this host are
 * named, since bwrap would fail on a missing mount point.
 */
async function hiddenResolverDirs(): Promise<string[]> {
	const args: string[] = [];
	for (const dir of ["/run/systemd/resolve", "/var/run/nscd"])
		if (await exists(dir)) args.push("--tmpfs", dir);
	return args;
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

/**
 * One `--ro-bind` per masked entry that is on the host, laying an empty
 * placeholder over it in the mount table bwrap gives qemu -- and qemu is the
 * 9p server, so the guest's share then has nothing of the host's at that path.
 * Read-only because the source is shared by every entry: a write through the
 * share must never land in it.
 *
 * An entry under another masked entry is skipped, since that placeholder
 * already hides it. An entry whose parent is there but which is missing itself
 * is skipped with a line: the guest will create it on the host as a directory,
 * which is what `node_modules` on a fresh clone needs. Refused, with an error
 * naming the entry, is what a guest could have arranged by renaming the
 * parent of a nested entry: a symlink, a path through one, or a parent that is
 * gone. So is an entry under a file, which the guest's mask script would fail
 * to create, stopping it before the entries after it are masked.
 */
export async function maskBinds(
	paths: Pick<FencePaths, "emptyFile" | "emptyDir">,
	mounts: Mounts,
	note: (line: string) => void = say,
): Promise<string[]> {
	const args: string[] = [];
	for (const entry of mounts.masked) {
		if (underMaskedDir(entry, mounts.masked)) continue;
		const kind = await maskKind(mounts.project, entry);
		if (kind === "symlink" || kind === "under-symlink") {
			throw new Error(
				`masked: ${entry} ${kind === "symlink" ? "is" : "is under"} a symlink on the host; replace it with the real path before starting`,
			);
		}
		if (kind === "parent-missing") {
			throw new Error(
				`masked: ${dirname(entry)} is not on the host, so ${entry} cannot be masked; restore it before starting`,
			);
		}
		if (kind === "under-file") {
			throw new Error(
				`masked: ${dirname(entry)} is a file on the host, so ${entry} cannot be masked; mask ${dirname(entry)} itself or remove the entry before starting`,
			);
		}
		if (kind === "missing") {
			note(
				`masked: ${entry} is not on the host; the guest will create it there as an empty directory`,
			);
		} else {
			args.push(
				"--ro-bind",
				kind === "dir" ? paths.emptyDir : paths.emptyFile,
				join(mounts.project, entry),
			);
		}
	}
	if (args.length > 0) {
		await mkdir(paths.emptyDir, { recursive: true });
		await writeFile(paths.emptyFile, "");
	}
	return args;
}

/** The mask binds come after the root bind, because they lay over what it mounted. */
export function bwrapArgv(
	binds: readonly string[],
	hidden: readonly string[],
	command: readonly string[],
): string[] {
	return [
		"--unshare-net",
		"--dev-bind",
		"/",
		"/",
		...binds,
		...hidden,
		"--die-with-parent",
		"--",
		...command,
	];
}

function socatListen(path: string, target: string): ChildProcess {
	return spawnSocat(unixListenAddress(path), target);
}

export async function runHelper(
	sandbox: string,
	instance: string,
): Promise<number> {
	const paths = fencePaths(sandbox);
	// Stamp first: a policy.json rewritten between the two reads then differs
	// from the stamp and is reloaded, rather than read once and taken as old.
	const stamp = await policyStamp(sandbox);
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

	const logFrom = await sizeOrZero(paths.gatekeeperLog);
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
			bwrapArgv([], await hiddenResolverDirs(), [
				process.execPath,
				cliPath(),
				"__net-inside",
				sandbox,
				instance,
			]),
			{ stdio: "inherit" },
		);
	}

	let record: HelperRecord = {
		...(await self()),
		gatekeeperPort: gatekeeper.port,
		ready: false,
		egress: false,
		policy: stamp,
	};
	const report = async (patch: Partial<HelperRecord>): Promise<void> => {
		record = { ...record, ...patch };
		await writeHelper(sandbox, record);
	};
	await report({});

	let stopping = false;
	const teardown = async (vmGone: boolean): Promise<void> => {
		if (stopping) return;
		stopping = true;
		await gatekeeper.close().catch(() => {});
		relay.kill("SIGKILL");
		await removeSocket(paths.egress);
		// Left in place otherwise: the inside half still owns it, and a reattach
		// needs it to keep `limactl shell` working. Once the VM is gone nothing
		// does, so what a reattach found running is killed along with it.
		if (vmGone) {
			await killFenceLeftovers(sandbox);
			await removeSocket(paths.control);
		}
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
	// Before `ready`, so the `playpen start` waiting on it can already name a
	// port that could not be bound. A fresh boot has no listeners yet; a guest
	// being reattached to may still run the last helper's, which nothing here
	// remembers.
	let forwarded = policy.ports;
	const unboundPorts = await forwardPorts(
		instance,
		reattach ? null : [],
		forwarded,
	);
	await report({ ready: true, egress, unboundPorts });
	say(`${instance} is up and fenced`);
	if (egress) {
		say(`the guest reached the gatekeeper`);
	} else {
		// Still ready, and the VM keeps running: it is fenced and usable, which
		// is what a sandbox with a broken tunnel needs in order to be repaired.
		say(`this sandbox has no network`);
		for (const line of NO_EGRESS_ADVICE) say(`  ${line}`);
	}

	await serveWhileRunning(sandbox, instance, stamp, async (next, applied) => {
		policy = next;
		// After the swap, so a new listener's first connection already finds
		// its `localhost:<host>` entry; and before the stamp is reported, so
		// `bringUp` returns with the listeners in place.
		const unboundPorts = await forwardPorts(instance, forwarded, next.ports);
		forwarded = next.ports;
		await report({ policy: applied, unboundPorts });
	});
	say(`${instance} is no longer running; shutting the fence down`);
	await teardown(true);
	return 0;
}

/**
 * Does the guest's own traffic reach the gatekeeper, and does a refusal reach
 * the guest? Everything else the helper knows is from out here, where a guest
 * whose tun2proxy died looks exactly like a healthy one, and a gatekeeper that
 * permits everything looks exactly like one applying the policy.
 *
 * The requests are driven from outside the fence over Lima's control path, so
 * a sandbox that passes has both directions working. `PROBE_HOST` and
 * `DENY_HOST` are answered by the policy and never dialed, so this costs no
 * connection and needs no allow entry; their two lines in the log, one
 * `probe` and one `deny`, are the whole signal. `--noproxy` keeps any proxy
 * variable in the guest out of it: only the route can carry this.
 */
async function guestReachesGatekeeper(
	instance: string,
	paths: FencePaths,
	logFrom: number,
): Promise<boolean> {
	const deadline = Date.now() + PROBE_WINDOW_MS;
	const ask = (host: string) =>
		`curl -s -o /dev/null --max-time 15 --noproxy '*' http://${host}/ || true`;
	for (;;) {
		await lima
			.runScript(instance, `${ask(PROBE_HOST)}\n${ask(DENY_HOST)}`)
			.catch((err: unknown) =>
				say(`warning: could not probe the guest: ${err}`),
			);
		if (await checksLogged(paths.gatekeeperLog, logFrom)) return true;
		if (Date.now() > deadline) return false;
		await sleep(2_000);
	}
}

/** Only what this helper's own gatekeeper appended: the lines from the
 * sandbox's last run would otherwise pass for this one's. */
async function checksLogged(path: string, from: number): Promise<boolean> {
	const { text } = await readAppended(path, from);
	let probed = false;
	let denied = false;
	for (const line of text.split("\n")) {
		if (line === "") continue;
		try {
			const entry = JSON.parse(line) as LogEntry;
			if (entry.verdict === "probe") probed = true;
			if (entry.verdict === "deny" && entry.host === DENY_HOST) denied = true;
		} catch {
			// A half-written last line; the next pass reads it whole.
		}
	}
	return probed && denied;
}

/** Named by the guest port, which is what a reload has to find again. */
function portUnit(guest: number): string {
	return `playpen-port-${guest}.service`;
}

/**
 * The guest script that takes its port listeners from `before` to `after`:
 * one transient systemd unit per entry, running a socat that listens on the
 * guest's `127.0.0.1:<guest>` and asks the gatekeeper for
 * `HOST_ALIAS:<host>` over the address tun2proxy uses, so each connection is
 * decided and logged like any other. `before` is null when what is running is
 * not known, and then every such unit is stopped first.
 *
 * An entry already listening is left alone, so a reload does not cut
 * connections through it. One whose port something else holds is not started,
 * and every entry not active at the end is printed as `unbound <guest>` for
 * `unboundIn` to read. The ports are validated integers, the one thing here
 * not written by this function.
 */
export function portsScript(
	before: readonly PortForward[] | null,
	after: readonly PortForward[],
): string {
	const lines: string[] = [];
	if (before === null) {
		lines.push(`systemctl stop 'playpen-port-*.service' 2>/dev/null || true`);
	} else {
		for (const old of before) {
			const kept = after.some(
				(p) => p.host === old.host && p.guest === old.guest,
			);
			if (!kept)
				lines.push(`systemctl stop ${portUnit(old.guest)} 2>/dev/null || true`);
		}
	}
	for (const { host, guest } of after) {
		const unit = portUnit(guest);
		lines.push(
			`if ! systemctl is-active --quiet ${unit} && ! ss -Hltn 'sport = :${guest}' | grep -q .; then`,
			`  systemd-run --quiet --collect --unit=${unit} socat TCP-LISTEN:${guest},bind=127.0.0.1,fork,reuseaddr PROXY:192.168.5.2:${HOST_ALIAS}:${host},proxyport=${GUEST_PROXY_PORT}`,
			"fi",
		);
	}
	if (after.length > 0) {
		// A socat that cannot bind exits just after it starts, and `--collect`
		// then unloads its unit, which reads as inactive.
		lines.push("sleep 1");
		for (const { guest } of after) {
			lines.push(
				`systemctl is-active --quiet ${portUnit(guest)} || echo 'unbound ${guest}'`,
			);
		}
	}
	return lines.join("\n");
}

/** The entries of `after` that `portsScript`'s output names as unbound. */
export function unboundIn(
	after: readonly PortForward[],
	stdout: string,
): PortForward[] {
	const named = new Set(
		stdout.split("\n").flatMap((line) => {
			const match = /^unbound (\d+)$/.exec(line.trim());
			return match ? [Number(match[1])] : [];
		}),
	);
	return after.filter(({ guest }) => named.has(guest));
}

/**
 * Returns the entries left unbound. A guest that cannot be asked at all is
 * taken to have none of them, so `playpen start` says so rather than
 * claiming ports that may not be there.
 */
async function forwardPorts(
	instance: string,
	before: readonly PortForward[] | null,
	after: readonly PortForward[],
): Promise<PortForward[]> {
	const script = portsScript(before, after);
	if (script === "") return [];
	let unbound: PortForward[];
	try {
		const result = await lima.runScript(instance, script, { root: true });
		if (result.code !== 0) throw new Error(result.stderr.trim());
		unbound = unboundIn(after, result.stdout.toString("utf8"));
		// systemd-run's own complaint, such as a guest with no socat.
		if (unbound.length > 0 && result.stderr.trim() !== "")
			say(result.stderr.trim());
	} catch (err) {
		say(`warning: could not set up forwarded ports in the guest: ${err}`);
		unbound = [...after];
	}
	for (const { host, guest } of after) {
		say(
			unbound.some((p) => p.guest === guest)
				? `warning: nothing could listen on the guest's localhost:${guest} for host port ${host}`
				: `host port ${host} is at the guest's localhost:${guest}`,
		);
	}
	return unbound;
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
