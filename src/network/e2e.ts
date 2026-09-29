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
 *
 * PLAYPEN_E2E_SECRET_HOST names a host that echoes the request's headers as
 * JSON at `/headers` (httpbin.org does); with it set, section 5 also checks
 * that a request from the guest reaches it with the real value in
 * `Authorization`, the one header a value goes into. The
 * helper verifies that host's certificate itself, so where this machine's own
 * egress is TLS-intercepted, run with NODE_EXTRA_CA_CERTS naming that
 * interceptor's CA.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { limaHome } from "../config.ts";
import { exists } from "../fs.ts";
import * as lima from "../lima/client.ts";
import { instanceName } from "../session/identity.ts";
import { profileCommand } from "../session/secrets.ts";
import { capture } from "../sh.ts";
import { sleep } from "../time.ts";
import { ensureCa } from "./ca.ts";
import {
	bringUp,
	fencePaths,
	fenceStatus,
	type HeldSecret,
	killFenceLeftovers,
	liveHelper,
	policyStamp,
	removeSocket,
} from "./fence.ts";
import type { LogEntry } from "./gatekeeper.ts";
import {
	BUILTIN_ALLOW,
	HOST_ALIAS,
	type PortForward,
	placeholderFor,
	type SecretGrant,
} from "./policy.ts";

const sandbox = process.env.PLAYPEN_E2E_SANDBOX ?? "fence-e2e";
const instance = instanceName(sandbox);
const template = process.env.PLAYPEN_E2E_TEMPLATE ?? "";
const tun2proxy = process.env.PLAYPEN_E2E_TUN2PROXY ?? "";
const allowedHost = process.env.PLAYPEN_E2E_ALLOWED ?? "nodejs.org";
const deniedHost = process.env.PLAYPEN_E2E_DENIED ?? "example.com";
const echoHost = process.env.PLAYPEN_E2E_SECRET_HOST ?? "";
/** Allowed by the built-in list and named by no secret. */
const unlistedHost = "registry.npmjs.org";
const paths = fencePaths(sandbox);

/**
 * Made up for the run: what is checked is where the value goes, not that any
 * service accepts it. `allowedHost` is always one of its hosts, so the
 * certificate check needs no echo host.
 */
const secret: HeldSecret = {
	env: "PLAYPEN_E2E_TOKEN",
	value: `e2e-${randomBytes(12).toString("hex")}`,
};
const secretGrant: SecretGrant = {
	env: secret.env,
	hosts: echoHost === "" ? [allowedHost] : [allowedHost, echoHost],
};
const GUEST_CA = "/tmp/playpen-ca.crt";

/**
 * Argv substrings that identify a process as belonging to this sandbox's
 * fence, the same ones `killFenceLeftovers` kills by: the outside relay and
 * the two inside socats all name `paths.egress` or `paths.control` on their
 * command line, and `__net-inside` names the sandbox itself.
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

/** Merges the way `startFenced` in session/lifecycle.ts does. */
async function up(
	allow: readonly string[] = [allowedHost],
	ports: readonly PortForward[] = [],
	secrets: readonly SecretGrant[] = [],
): Promise<void> {
	await bringUp({
		sandbox,
		instance,
		policy: {
			allow: [
				...BUILTIN_ALLOW,
				...allow,
				...ports.map(({ host }) => `localhost:${host}`),
				...secrets.flatMap(({ hosts }) => hosts),
			],
			mode: "enforce",
			ports,
			secrets,
		},
		secrets: secrets.length === 0 ? [] : [secret],
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
		await step("a query to Lima's resolver address gets no answer", noDns);
		await step(
			"a rewritten policy is applied before bringUp returns",
			policyApplied,
		);
		await step(
			"a host port listed in `ports` answers at the guest's own localhost",
			forwardedPort,
		);

		console.log("\n4. killing the helper");
		await step("the VM survives it, still fenced", helperKilled);
		await step("with no way out until a helper comes back", noEgress);
		await step("and a new helper reattaches to it", reattach);
		await step(`${allowedHost} answers again`, allowedAnswers);

		console.log("\n5. a secret");
		if (await step("a helper holding a secret replaces this one", holdSecret)) {
			await step(
				`${allowedHost}, a secret's host, shows the playpen CA's certificate`,
				secretHostIssuer,
			);
			await step(
				`${unlistedHost}, named by no secret, shows its own`,
				unlistedIssuer,
			);
			if (echoHost === "") {
				console.log(
					"  skip  the value reaches the host (no PLAYPEN_E2E_SECRET_HOST)",
				);
			} else {
				await step(
					`${echoHost} gets the value in Authorization, the guest's environment only the placeholder`,
					valueInjected,
				);
			}
		}

		console.log("\n6. stopping the VM from outside");
		await step("the helper tears the fence down and exits", stopped);
	} finally {
		console.log("\n7. leftover processes for this sandbox");
		try {
			await step(
				"no socat or __net-inside process left running",
				noLeftoverProcesses,
			);
		} finally {
			await cleanUp();
		}
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exitCode = failed === 0 ? 0 : 1;
}

async function running(pattern: string): Promise<boolean> {
	const { stdout } = await capture("pgrep", ["-f", pattern]);
	return stdout.trim() !== "";
}

/** Runs on every exit path so a failed step still leaves the machine tidy. */
async function cleanUp(): Promise<void> {
	await killFenceLeftovers(sandbox);
	await removeSocket(paths.egress);
	await removeSocket(paths.control);
}

/**
 * Checked before `cleanUp`, not after: the helper's own teardown is what must
 * have killed the inside socats the reattach in section 4 found running.
 */
async function noLeftoverProcesses(): Promise<string | null> {
	const stillUp = await Promise.all(LEFTOVER_PATTERNS.map(running));
	return stillUp.some(Boolean)
		? "a socat or __net-inside process for this sandbox is still running"
		: null;
}

/**
 * Lima's host resolver is off in the template, so the address the guest
 * would ask, 192.168.5.3, is qemu's own forwarder -- which sends plain UDP to
 * the host's nameservers, and inside the fence that has no route. A guest
 * process asking it directly, past the system resolver that points at tun0,
 * must get no answer with a record in it. python3 rather than dig, which the
 * cloud image does not ship; the query is an A lookup for example.com, and
 * the number printed is the answer count from the reply header.
 */
async function noDns(): Promise<string | null> {
	const out = await guest(
		[
			"python3 - <<'PY'",
			"import socket",
			"s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)",
			"s.settimeout(3)",
			"query = bytes.fromhex('1234 0100 0001 0000 0000 0000') + b'\\x07example\\x03com\\x00\\x00\\x01\\x00\\x01'",
			"s.sendto(query, ('192.168.5.3', 53))",
			"try:",
			"    reply = s.recv(512)",
			"    print(int.from_bytes(reply[6:8], 'big'))",
			"except OSError:",
			"    print('none')",
			"PY",
		].join("\n"),
	);
	return out === "none" || out === "0" ? null : `got ${out} answer record(s)`;
}

async function policyApplied(): Promise<string | null> {
	await up([allowedHost, "retightened.example"]);
	const stamp = await policyStamp(sandbox);
	const helper = await liveHelper(sandbox);
	return wanted("applied policy stamp", stamp, helper?.policy ?? "none");
}

/**
 * This VM has none of the base image's layers, so socat is installed here
 * from Ubuntu's own archive, through the fence: its two names are allowed for
 * the install and dropped again with the policy that lists the port. The host
 * side is this process's own listener on the host's loopback, where nothing
 * but a `localhost:<host>` entry can reach it.
 */
async function forwardedPort(): Promise<string | null> {
	await up([allowedHost, "archive.ubuntu.com", "security.ubuntu.com"]);
	const socat = await guest(
		[
			"if ! command -v socat >/dev/null; then",
			"  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq socat",
			"fi >/dev/null 2>&1",
			"command -v socat",
		].join("\n"),
		[],
		true,
	);
	if (socat === "") return "socat did not install in the guest";

	const server = createServer((_req, res) => res.end("from the host\n"));
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	try {
		const host = (server.address() as AddressInfo).port;
		const guestPort = 4321;
		await up([allowedHost], [{ host, guest: guestPort }]);
		const unbound = (await liveHelper(sandbox))?.unboundPorts ?? [];
		if (unbound.length > 0)
			return `the helper reports guest port ${guestPort} unbound`;

		const body = await guest(
			`curl -sS --noproxy '*' --max-time 30 http://localhost:${guestPort}/`,
		);
		if (body !== "from the host") {
			return `the guest's localhost:${guestPort} answered "${body}"`;
		}
		const logged = (await gatekeeperLog()).some(
			(e) => e.host === HOST_ALIAS && e.port === host && e.verdict === "allow",
		);
		return logged ? null : `no allow line for ${HOST_ALIAS}:${host}`;
	} finally {
		server.closeAllConnections();
		server.close();
	}
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
	const sshSocket = join(limaHome(), instance, "ssh.sock");
	await capture("pkill", ["-f", sshSocket]);
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

/**
 * A helper takes its values only when it is spawned, so the running one is
 * killed and a new one reattached with the secret. The guest then gets what
 * `playpen start` would give it: the placeholder in its login profile, and the
 * CA certificate the base image would have installed, as a file this VM's
 * clients are pointed at.
 */
async function holdSecret(): Promise<string | null> {
	const helper = await liveHelper(sandbox);
	if (helper !== null) process.kill(helper.pid, "SIGKILL");
	const gone = await waitFor("the old helper's exit", 30, async () => {
		const state = await fenceStatus(sandbox, instance);
		return state === "sealed-no-gatekeeper";
	});
	if (gone !== null) return gone;
	await up([allowedHost], [], [secretGrant]);
	const held = (await liveHelper(sandbox))?.secrets ?? [];
	if (!held.includes(secret.env)) return `the helper holds ${held.join(", ")}`;

	const { script, input } = profileCommand([
		{ env: secret.env, placeholder: placeholderFor(secret.env) },
	]);
	await lima.runScript(instance, script, {
		root: true,
		...(input === undefined ? {} : { input }),
	});
	await lima.runScript(instance, `cat > ${GUEST_CA}`, {
		input: (await ensureCa()).certPem,
	});
	return null;
}

/** The issuer of the certificate the guest is shown for `host`, or "". */
function issuerSeen(host: string): Promise<string> {
	return guest(
		`openssl s_client -connect "$1:443" -servername "$1" </dev/null 2>/dev/null | openssl x509 -noout -issuer`,
		[host],
	);
}

async function secretHostIssuer(): Promise<string | null> {
	const issuer = await issuerSeen(allowedHost);
	return issuer.includes("playpen sandbox CA") ? null : `issuer: ${issuer}`;
}

async function unlistedIssuer(): Promise<string | null> {
	const issuer = await issuerSeen(unlistedHost);
	if (issuer === "") return "no certificate";
	return issuer.includes("playpen sandbox CA") ? `issuer: ${issuer}` : null;
}

/**
 * Through a login shell, so the header carries whatever the guest's own
 * environment holds for the variable, as an agent's request would.
 */
async function valueInjected(): Promise<string | null> {
	const placeholder = placeholderFor(secret.env);
	const seen = await guest(`bash -lc 'printenv ${secret.env}'`);
	if (seen !== placeholder) return `the guest's ${secret.env} is "${seen}"`;
	const environment = await guest("bash -lc env");
	if (environment.includes(secret.value))
		return "the guest's environment holds the value";

	const echoed = await guest(
		`bash -lc 'curl -sS --noproxy "*" --max-time 60 --cacert ${GUEST_CA}` +
			` -H "Authorization: token $${secret.env}" "https://$0/headers"' "$1"`,
		[echoHost],
	);
	let authorization: unknown;
	try {
		authorization = JSON.parse(echoed)?.headers?.Authorization;
	} catch {
		return `${echoHost} did not answer with JSON: ${echoed.slice(0, 200)}`;
	}
	if (authorization !== `token ${secret.value}`) {
		return `${echoHost} echoed Authorization as ${JSON.stringify(authorization)}, not the value`;
	}

	const entries = await gatekeeperLog();
	const injected = entries.some(
		(e) =>
			e.verdict === "inject" &&
			e.host === echoHost &&
			e.env === secret.env &&
			e.header.toLowerCase() === "authorization",
	);
	if (!injected) return `no inject line for ${echoHost}`;
	const raw = await readFile(paths.gatekeeperLog, "utf8");
	return raw.includes(secret.value) ? "gatekeeper.log holds the value" : null;
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
