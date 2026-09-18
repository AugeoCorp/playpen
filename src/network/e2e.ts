#!/usr/bin/env node
/**
 * The network fence, proved against a real Lima VM.
 *
 * Nothing here is a unit test: it boots a guest, cuts its own control
 * connection, kills the helper and stops the VM, so it lives outside `npm test`
 * and is run by hand. Everything it needs is named by an environment variable
 * so the same script runs on a maintainer's machine:
 *
 *   PLAYPEN_E2E_TUN2PROXY=/path/to/tun2proxy-bin \
 *   PLAYPEN_E2E_TEMPLATE=/path/to/vm.yaml \
 *   XDG_DATA_HOME=$HOME/.local/share \
 *   node src/network/e2e.ts
 *
 * The instance is created if it does not exist and left stopped at the end.
 */
import { readFile } from "node:fs/promises";
import { exists } from "../fs.ts";
import * as lima from "../lima/client.ts";
import { instanceName } from "../session/identity.ts";
import { capture } from "../sh.ts";
import {
	bringUp,
	fencePaths,
	fenceStatus,
	liveHelper,
	removeSocket,
} from "./fence.ts";
import type { LogEntry } from "./gatekeeper.ts";
import { BUILTIN_ALLOW } from "./policy.ts";

const sandbox = process.env.PLAYPEN_E2E_SANDBOX ?? "fence-e2e";
const instance = instanceName(sandbox);
const template = process.env.PLAYPEN_E2E_TEMPLATE ?? "";
const tun2proxy = process.env.PLAYPEN_E2E_TUN2PROXY ?? "";
const allowedHost = process.env.PLAYPEN_E2E_ALLOWED ?? "nodejs.org";
const deniedHost = process.env.PLAYPEN_E2E_DENIED ?? "example.com";
const paths = fencePaths(sandbox);

/**
 * Argv substrings that identify a process as belonging to this sandbox's
 * fence: the outside relay and the two inside socats all name `paths.egress`
 * or `paths.control` on their command line, and `__net-inside` names the
 * sandbox itself. A SIGKILLed helper leaves these orphaned with no other
 * record of them, so this is how a later step finds and kills them without
 * touching another sandbox's fence.
 */
const LEFTOVER_PATTERNS = [
	paths.egress,
	paths.control,
	`__net-inside ${sandbox} `,
];

/**
 * `-k` because this container's own egress is TLS-intercepted, so the
 * certificate the guest sees on an allowed host is the interceptor's, and `-L`
 * because a front page that redirects is still a front page that answered.
 */
const CURL = "curl -kL -sS --noproxy '*' -o /dev/null -w '%{http_code}'";

const STRIP_PROXY =
	"unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let passed = 0;
let failed = 0;

async function step(
	name: string,
	fn: () => Promise<string | null>,
): Promise<boolean> {
	const began = Date.now();
	let detail: string | null;
	try {
		detail = await fn();
	} catch (err) {
		detail = err instanceof Error ? err.message : String(err);
	}
	const secs = `${((Date.now() - began) / 1000).toFixed(1)}s`;
	if (detail === null) {
		passed++;
		console.log(`  ok    ${name} (${secs})`);
		return true;
	}
	failed++;
	console.log(`  FAIL  ${name} (${secs}): ${detail}`);
	return false;
}

function wanted(what: string, expected: string, got: string): string | null {
	return expected === got ? null : `${what}: wanted ${expected}, got ${got}`;
}

/** A command in the guest, with every proxy variable removed first. */
async function guest(
	script: string,
	args: readonly string[] = [],
	root = false,
): Promise<string> {
	const result = await lima.runScript(instance, `${STRIP_PROXY}\n${script}`, {
		args,
		root,
	});
	return result.stdout.toString("utf8").trim();
}

function httpCode(url: string, seconds: number): Promise<string> {
	return guest(`${CURL} --max-time "$2" "$1"`, [url, String(seconds)]);
}

async function gatekeeperLog(): Promise<LogEntry[]> {
	const raw = await readFile(paths.gatekeeperLog, "utf8").catch(() => "");
	return raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as LogEntry);
}

async function waitFor(
	what: string,
	seconds: number,
	ready: () => Promise<boolean>,
): Promise<string | null> {
	const deadline = Date.now() + seconds * 1000;
	while (Date.now() < deadline) {
		if (await ready()) return null;
		await sleep(1000);
	}
	return `${what} did not happen within ${seconds}s`;
}

async function up(): Promise<void> {
	await bringUp({
		sandbox,
		instance,
		policy: { allow: [...BUILTIN_ALLOW, allowedHost], mode: "enforce" },
		log: (text) => process.stderr.write(text),
	});
}

async function main(): Promise<void> {
	if (tun2proxy === "") {
		console.error("set PLAYPEN_E2E_TUN2PROXY to a linux tun2proxy binary");
		process.exit(2);
	}
	console.log(`sandbox ${sandbox} (${instance}), runtime dir ${paths.dir}`);

	try {
		console.log("\n1. the sandbox comes up behind the gatekeeper");
		if (!(await step("the instance exists", createIfMissing))) return;
		if (!(await step("the helper reports it ready", startFenced))) return;

		console.log("\n2. reaching the guest from outside the fence");
		await step("limactl shell works over Lima's own socket", overLimaSocket);
		await step(
			"and still works once that socket's master is killed",
			overControl,
		);

		console.log("\n3. what the guest can reach");
		await step("tun2proxy routes the guest at the gatekeeper", startTun2proxy);
		await step(`${allowedHost} answers through the chain`, allowedAnswers);
		await step(`${deniedHost} is refused`, deniedRefused);
		await step("a raw socket with no proxy setting gets out", rawSocket);
		await step("the gatekeeper logged both verdicts", bothVerdicts);

		console.log("\n4. killing the helper");
		await step("the VM survives it, still fenced", helperKilled);
		await step("with no way out until a helper comes back", noEgress);
		await step("and a new helper reattaches to it", reattach);
		await step(`${allowedHost} answers again`, allowedAnswers);

		console.log("\n5. stopping the VM from outside");
		await step("the helper tears the fence down and exits", stopped);
	} finally {
		console.log("\n6. leftover processes for this sandbox");
		await step(
			"no socat or __net-inside process left running",
			noLeftoverProcesses,
		);
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exitCode = failed === 0 ? 0 : 1;
}

async function running(pattern: string): Promise<boolean> {
	const { stdout } = await capture("pgrep", ["-f", pattern]);
	return stdout.trim() !== "";
}

/** Best effort, like `removeSocket`: a process already gone is the outcome wanted. */
async function killLeftovers(): Promise<void> {
	for (const pattern of LEFTOVER_PATTERNS)
		await capture("pkill", ["-9", "-f", pattern]);
	await removeSocket(paths.egress);
	await removeSocket(paths.control);
}

/**
 * Runs on every exit path, including a failed step: the reattach in section 4
 * leaves the killed run's inside socats holding the fence's sockets, and a
 * thrown step would otherwise skip cleanup entirely.
 */
async function noLeftoverProcesses(): Promise<string | null> {
	await killLeftovers();
	await sleep(200);
	const stillUp = await Promise.all(LEFTOVER_PATTERNS.map(running));
	return stillUp.some(Boolean)
		? "a socat or __net-inside process for this sandbox is still running"
		: null;
}

async function createIfMissing(): Promise<string | null> {
	if ((await lima.get(instance)) !== null) return null;
	if (template === "") return "no instance, and PLAYPEN_E2E_TEMPLATE is unset";
	const { code, stderr } = await capture("limactl", [
		"create",
		`--name=${instance}`,
		"--tty=false",
		template,
	]);
	return code === 0 ? null : `limactl create exited ${code}: ${stderr.trim()}`;
}

/**
 * This VM has none of the base image's layers, so tun2proxy is not running yet
 * and the helper's probe finds no egress: the honest state here is
 * sealed-no-egress. The reattach in section 4 probes again, after section 3
 * has started tun2proxy by hand, and is where "sealed" is expected.
 */
async function startFenced(): Promise<string | null> {
	await up();
	return wanted(
		"fence state",
		"sealed-no-egress",
		await fenceStatus(sandbox, instance),
	);
}

/**
 * Plain `limactl shell`, with none of the environment playpen's own client
 * sets: this is Lima's multiplexed connection over `ssh.sock` and nothing else.
 * Through `timeout` because an ssh with nowhere left to go waits a long time.
 */
async function overLimaSocket(): Promise<string | null> {
	const { code } = await capture("timeout", [
		"60",
		"limactl",
		"shell",
		instance,
		"--",
		"true",
	]);
	return wanted("exit code", "0", String(code));
}

/**
 * Lima multiplexes over `<instance>/ssh.sock`, which is a file and so crosses
 * the fence on its own. Killing its master is what leaves only the control
 * socket, which is the path playpen has to work over.
 */
async function overControl(): Promise<string | null> {
	await capture("pkill", ["-f", "ssh.sock"]);
	await sleep(2000);

	// Held open long enough to catch the connection in `ss`, which is the
	// evidence that it is the control socket carrying it and not a master Lima
	// quietly rebuilt.
	const busy = lima.runScript(instance, "sleep 15");
	await sleep(6000);
	const { stdout } = await capture("ss", ["-x", "-p"]);
	const onSocket = stdout.includes(paths.control);

	const result = await busy;
	if (result.code !== 0) {
		return `limactl shell exited ${result.code}: ${result.stderr.trim()}`;
	}
	return onSocket ? null : `no connection to ${paths.control} in \`ss -x -p\``;
}

async function startTun2proxy(): Promise<string | null> {
	const copy = await capture("limactl", [
		"copy",
		tun2proxy,
		`${instance}:/tmp/tun2proxy-bin`,
	]);
	if (copy.code !== 0) return `limactl copy: ${copy.stderr.trim()}`;

	await guest(
		[
			"install -m 755 /tmp/tun2proxy-bin /usr/local/bin/tun2proxy-bin",
			// The bypass keeps the reply path to qemu's own gateway off the tun,
			// which is also the route the gatekeeper's traffic comes back on.
			"nohup tun2proxy-bin --proxy http://192.168.5.2:1080 --setup" +
				" --dns virtual --bypass 192.168.5.0/24" +
				" >/tmp/tun2proxy.log 2>&1 &",
		].join("\n"),
		[],
		true,
	);
	const route = await waitFor("a tun device", 60, async () =>
		(await guest("ip route get 1.1.1.1")).includes("tun"),
	);
	if (route !== null) return route;
	return null;
}

async function allowedAnswers(): Promise<string | null> {
	return wanted(
		"http code",
		"200",
		await httpCode(`https://${allowedHost}/`, 120),
	);
}

/**
 * The gatekeeper refuses the CONNECT with a 403, which tun2proxy can only pass
 * on as a dead socket: the guest sees a failure to connect, not a status.
 */
async function deniedRefused(): Promise<string | null> {
	const began = Date.now();
	const code = await httpCode(`https://${deniedHost}/`, 60);
	const secs = (Date.now() - began) / 1000;
	if (code === "200") return `${deniedHost} answered 200`;
	return secs < 30 ? null : `refused, but took ${secs.toFixed(1)}s`;
}

async function rawSocket(): Promise<string | null> {
	const opened = await guest(
		`timeout 60 bash -c 'exec 3<>/dev/tcp/$1/443' bash "$1" >/dev/null 2>&1` +
			" && echo open || echo shut",
		[allowedHost],
	);
	return wanted("/dev/tcp", "open", opened);
}

async function bothVerdicts(): Promise<string | null> {
	const entries = await gatekeeperLog();
	const allow = entries.some(
		(e) => e.host === allowedHost && e.verdict === "allow",
	);
	const deny = entries.some(
		(e) => e.host === deniedHost && e.verdict === "deny",
	);
	if (allow && deny) return null;
	return `allow line for ${allowedHost}: ${allow}, deny line for ${deniedHost}: ${deny}`;
}

async function helperKilled(): Promise<string | null> {
	const helper = await liveHelper(sandbox);
	if (helper === null) return "no live helper to kill";
	process.kill(helper.pid, "SIGKILL");
	await sleep(2000);
	if (!lima.isRunning(await lima.get(instance))) return "the VM stopped too";
	return wanted(
		"fence state",
		"sealed-no-gatekeeper",
		await fenceStatus(sandbox, instance),
	);
}

async function noEgress(): Promise<string | null> {
	return wanted(
		"http code",
		"000",
		await httpCode(`https://${allowedHost}/`, 30),
	);
}

async function reattach(): Promise<string | null> {
	await up();
	return wanted("fence state", "sealed", await fenceStatus(sandbox, instance));
}

async function stopped(): Promise<string | null> {
	await lima.stop(instance);
	return waitFor(
		"the fence teardown",
		60,
		async () =>
			!(await exists(paths.helper)) &&
			!(await exists(paths.egress)) &&
			!(await exists(paths.control)),
	);
}

await main();
