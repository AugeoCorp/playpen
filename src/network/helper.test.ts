import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { type TestContext, test } from "node:test";
import tls from "node:tls";
import { ensureCa } from "./ca.ts";
import { cliPath } from "./fence.ts";
import {
	describeHeld,
	portsScript,
	readHeldSecrets,
	startFenceGatekeeper,
	unboundIn,
} from "./helper.ts";
import type { Policy } from "./policy.ts";

/** The units a script stops, in order, glob included. */
function stops(script: string): string[] {
	return [...script.matchAll(/^systemctl stop (\S+)/gm)].map((m) => m[1] ?? "");
}

/** The units a script can start, in order. */
function starts(script: string): string[] {
	return [...script.matchAll(/systemd-run .*--unit=(\S+)/g)].map(
		(m) => m[1] ?? "",
	);
}

test("a listener forwards the guest's loopback port to the host port through the gatekeeper's address", () => {
	const script = portsScript([], [{ host: 5000, guest: 4321 }]);
	assert.match(
		script,
		/socat TCP-LISTEN:4321,bind=127\.0\.0\.1,fork,reuseaddr PROXY:192\.168\.5\.2:host\.playpen\.internal:5000,proxyport=1080$/m,
	);
});

test("with nothing forwarded before or after, the guest is not asked at all", () => {
	assert.equal(portsScript([], []), "");
});

test("when what is running is unknown, every port unit is stopped before any is started", () => {
	const script = portsScript(null, [{ host: 5000, guest: 4321 }]);
	assert.deepEqual(stops(script), ["'playpen-port-*.service'"]);
	assert.deepEqual(starts(script), ["playpen-port-4321.service"]);
	assert.ok(
		script.indexOf("systemctl stop") < script.indexOf("systemd-run"),
		`expected the stop before the start in:\n${script}`,
	);
});

test("a reattach with no ports still clears what the last helper left listening", () => {
	assert.deepEqual(stops(portsScript(null, [])), ["'playpen-port-*.service'"]);
});

test("an entry that went away is stopped and one that stayed is not", () => {
	const kept = { host: 5000, guest: 4321 };
	const script = portsScript([kept, { host: 6000, guest: 6000 }], [kept]);
	assert.deepEqual(stops(script), ["playpen-port-6000.service"]);
	assert.deepEqual(starts(script), ["playpen-port-4321.service"]);
});

test("an entry that stayed is only started if its unit is not already active", () => {
	const kept = { host: 5000, guest: 4321 };
	assert.match(
		portsScript([kept], [kept]),
		/^if ! systemctl is-active --quiet playpen-port-4321\.service && /m,
	);
});

test("a guest port something else listens on is left to it", () => {
	assert.match(
		portsScript([], [{ host: 5000, guest: 4321 }]),
		/! ss -Hltn 'sport = :4321' \| grep -q \.; then$/m,
	);
});

test("a guest port moved to another host port is stopped and started again", () => {
	const script = portsScript(
		[{ host: 5000, guest: 4321 }],
		[{ host: 5001, guest: 4321 }],
	);
	assert.deepEqual(stops(script), ["playpen-port-4321.service"]);
	assert.deepEqual(starts(script), ["playpen-port-4321.service"]);
	assert.match(script, /host\.playpen\.internal:5001,/);
	assert.ok(
		script.indexOf("systemctl stop") < script.indexOf("systemd-run"),
		`expected the stop before the start in:\n${script}`,
	);
});

test("every entry not active at the end is printed as unbound", () => {
	const script = portsScript(
		[],
		[
			{ host: 5000, guest: 4321 },
			{ host: 6000, guest: 6000 },
		],
	);
	assert.match(
		script,
		/^systemctl is-active --quiet playpen-port-4321\.service \|\| echo 'unbound 4321'$/m,
	);
	assert.match(
		script,
		/^systemctl is-active --quiet playpen-port-6000\.service \|\| echo 'unbound 6000'$/m,
	);
});

test("the entries named unbound are the ones reported, by guest port", () => {
	const after = [
		{ host: 5000, guest: 4321 },
		{ host: 6000, guest: 6000 },
	];
	assert.deepEqual(unboundIn(after, "noise\nunbound 6000\n"), [
		{ host: 6000, guest: 6000 },
	]);
	assert.deepEqual(unboundIn(after, ""), []);
});

test("an unbound line for a port not asked for is ignored", () => {
	assert.deepEqual(
		unboundIn([{ host: 5000, guest: 4321 }], "unbound 22\nunbound 4321x\n"),
		[],
	);
});

const TOKEN = "ghp_correct-horse-battery-staple";

const document = JSON.stringify({
	secrets: [
		{ env: "GH_TOKEN", value: TOKEN },
		{ env: "NPM_TOKEN", value: "npm_abc" },
	],
});

test("the helper reads its secrets from a document on stdin", async () => {
	const held = await readHeldSecrets(Readable.from([document]));
	assert.deepEqual(held, [
		{ env: "GH_TOKEN", value: TOKEN },
		{ env: "NPM_TOKEN", value: "npm_abc" },
	]);
});

test("a helper handed nothing at all refuses to start rather than serving with no answer", async () => {
	await assert.rejects(
		readHeldSecrets(Readable.from([])),
		/the helper's stdin is not JSON/,
	);
});

test("the helper's log line for its secrets is a count and names", async () => {
	const held = await readHeldSecrets(Readable.from([document]));
	assert.equal(describeHeld(held), "holding 2 secrets: GH_TOKEN, NPM_TOKEN");
	assert.equal(describeHeld(held.slice(0, 1)), "holding 1 secret: GH_TOKEN");
});

/**
 * `playpen __net-helper` as `spawnHelper` runs it, with nothing else set up.
 * With no policy.json to read it stops on its own soon after logging; the
 * timeout is only there so a helper that starts serving fails the test rather
 * than hanging it.
 */
function runHelperProcess(stdin: string) {
	const root = mkdtempSync(join(tmpdir(), "playpen-helper-"));
	try {
		return spawnSync(
			process.execPath,
			[cliPath(), "__net-helper", "api-abc123", "playpen-api-abc123"],
			{
				input: stdin,
				encoding: "utf8",
				timeout: 10_000,
				env: {
					...process.env,
					XDG_DATA_HOME: join(root, "data"),
					LIMA_HOME: join(root, "lima"),
				},
			},
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("a helper handed a value says how many secrets it holds and never says the value", () => {
	const ran = runHelperProcess(document);
	const log = `${ran.stdout}${ran.stderr}`;
	assert.equal(ran.signal, null, `the helper was killed:\n${log}`);
	assert.match(log, /holding 2 secrets: GH_TOKEN, NPM_TOKEN/);
	assert.equal(log.includes(TOKEN), false, `the log held the value:\n${log}`);
	assert.equal(log.includes("npm_abc"), false, `the log held a value:\n${log}`);
});

test("a helper handed a malformed document exits naming the key and without the value", () => {
	const bad = JSON.stringify({ secrets: [{ env: "gh token", value: TOKEN }] });
	const ran = runHelperProcess(bad);
	const log = `${ran.stdout}${ran.stderr}`;
	assert.equal(ran.status, 1, log);
	assert.match(log, /`secrets\[0\]\.env` must be an environment variable name/);
	assert.equal(log.includes(TOKEN), false, `the log held the value:\n${log}`);
});

/**
 * A CONNECT for `host:443` through `port`, then TLS for `host` trusting only
 * `caPem`. Resolves with the certificate the client was shown, or rejects
 * with "closed" when the gatekeeper hung up instead of answering. It is
 * closed through the TLS socket, not the one under it.
 */
function certificateThrough(
	t: TestContext,
	port: number,
	host: string,
	caPem: string,
): Promise<X509Certificate> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1");
		socket.on("error", () => reject(new Error("closed")));
		socket.on("close", () => reject(new Error("closed")));
		socket.once("connect", () =>
			socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`),
		);
		socket.once("data", () => {
			const secure = tls.connect(
				{ socket, servername: host, ca: caPem },
				() => {
					const cert = secure.getPeerX509Certificate();
					if (cert === undefined) reject(new Error("no certificate"));
					else resolve(cert);
				},
			);
			secure.on("error", reject);
			t.after(() => secure.destroy());
		});
	});
}

async function withTempData(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "playpen-helper-ca-"));
	const before = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = dir;
	t.after(async () => {
		if (before === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = before;
		await rm(dir, { recursive: true, force: true });
	});
	return dir;
}

const secretPolicy: Policy = {
	allow: ["api.example"],
	mode: "enforce",
	ports: [],
	secrets: [{ env: "GH_TOKEN", hosts: ["api.example"] }],
};

test("the helper's gatekeeper terminates TLS for a secret's host with the install's CA", async (t) => {
	await withTempData(t);
	const ca = await ensureCa();
	const gatekeeper = await startFenceGatekeeper({
		held: [{ env: "GH_TOKEN", value: TOKEN }],
		policy: () => secretPolicy,
		log: () => {},
		resolve: async () => [{ address: "127.0.0.1", family: 4 }],
	});
	t.after(() => gatekeeper.close());

	const cert = await certificateThrough(
		t,
		gatekeeper.port,
		"api.example",
		ca.certPem,
	);
	assert.equal(cert.subjectAltName, "DNS:api.example");
});

test("the helper's gatekeeper holding a secret with no CA on disk fails to start, and makes none the guest would not trust", async (t) => {
	const dataHome = await withTempData(t);

	await assert.rejects(
		startFenceGatekeeper({
			held: [{ env: "GH_TOKEN", value: TOKEN }],
			policy: () => secretPolicy,
			log: () => {},
		}),
		/no playpen CA in .*playpen\/ca to sign certificates/,
	);
	assert.equal(existsSync(join(dataHome, "playpen", "ca")), false);
});

test("the helper's gatekeeper holding no secret pipes the same host, and never makes a CA", async (t) => {
	const dataHome = await withTempData(t);
	const gatekeeper = await startFenceGatekeeper({
		held: [],
		policy: () => secretPolicy,
		log: () => {},
		resolve: async () => [{ address: "127.0.0.1", family: 4 }],
	});
	t.after(() => gatekeeper.close());

	await assert.rejects(
		certificateThrough(t, gatekeeper.port, "api.example", ""),
		{ message: "closed" },
	);
	assert.equal(existsSync(join(dataHome, "playpen", "ca")), false);
});
