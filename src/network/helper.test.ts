import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { cliPath } from "./fence.ts";
import {
	describeHeld,
	portsScript,
	readHeldSecrets,
	unboundIn,
} from "./helper.ts";

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
		{
			env: "GH_TOKEN",
			placeholder: "playpen-secret-gh-token-3f9a0c1d5e7b2468",
			value: TOKEN,
			hosts: ["api.github.com"],
		},
		{
			env: "NPM_TOKEN",
			placeholder: "playpen-secret-npm-token-0123456789abcdef",
			value: "npm_abc",
			hosts: ["registry.example.com"],
		},
	],
});

test("the helper reads its secrets from a stream that arrives in pieces", async () => {
	const bytes = Buffer.from(document);
	const pieces = [
		bytes.subarray(0, 20),
		bytes.subarray(20, 75),
		bytes.subarray(75),
	];
	const held = await readHeldSecrets(Readable.from(pieces));
	assert.deepEqual(
		held.map(({ env, value }) => [env, value]),
		[
			["GH_TOKEN", TOKEN],
			["NPM_TOKEN", "npm_abc"],
		],
	);
});

test("a value with characters that take several bytes survives being split across pieces", async () => {
	const text = JSON.stringify({
		secrets: [
			{
				env: "GH_TOKEN",
				placeholder: "playpen-secret-gh-token-3f9a0c1d5e7b2468",
				value: "pässwörd-日本語",
				hosts: ["api.github.com"],
			},
		],
	});
	const bytes = Buffer.from(text);
	const cut = bytes.indexOf(Buffer.from("日")) + 1;
	const held = await readHeldSecrets(
		Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]),
	);
	assert.equal(held[0]?.value, "pässwörd-日本語");
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

/** `playpen __net-helper` as `spawnHelper` runs it, with nothing else set up. */
function runHelperProcess(stdin: string) {
	const root = mkdtempSync(join(tmpdir(), "playpen-helper-"));
	try {
		return spawnSync(
			process.execPath,
			[cliPath(), "__net-helper", "api-abc123", "playpen-api-abc123"],
			{
				input: stdin,
				encoding: "utf8",
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
	assert.match(log, /holding 2 secrets: GH_TOKEN, NPM_TOKEN/);
	assert.equal(log.includes(TOKEN), false, `the log held the value:\n${log}`);
	assert.equal(log.includes("npm_abc"), false, `the log held a value:\n${log}`);
});

test("a helper handed a malformed document exits naming the key and without the value", () => {
	const bad = JSON.stringify({
		secrets: [
			{
				env: "gh token",
				placeholder: "playpen-secret-gh-token-3f9a0c1d5e7b2468",
				value: TOKEN,
				hosts: ["api.github.com"],
			},
		],
	});
	const ran = runHelperProcess(bad);
	const log = `${ran.stdout}${ran.stderr}`;
	assert.equal(ran.status, 1, log);
	assert.match(log, /`secrets\[0\]\.env` must be an environment variable name/);
	assert.equal(log.includes(TOKEN), false, `the log held the value:\n${log}`);
});
