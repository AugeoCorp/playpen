import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { sleep } from "../time.ts";
import { cliPath, fencePaths, writePolicy } from "./fence.ts";
import { portsScript, unboundIn } from "./helper.ts";

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

/**
 * `playpen __net-helper` as `spawnHelper` runs it, in an empty data directory.
 * With no policy.json to read it stops on its own once it is past its stdin.
 */
function runHelperProcess(stdin: string): string {
	const root = mkdtempSync(join(tmpdir(), "playpen-helper-"));
	try {
		const ran = spawnSync(
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
		return `${ran.stdout}${ran.stderr}`;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("a helper reads the secrets on its stdin, and logs no value", () => {
	const log = runHelperProcess(
		JSON.stringify([{ env: "GH_TOKEN", value: "ghp_a" }]),
	);
	assert.doesNotMatch(log, /cannot read the secrets/);
	assert.equal(log.includes("ghp_a"), false, log);
});

test("a helper whose stdin is not a list of secrets stops, and logs none of it", () => {
	const log = runHelperProcess('[{ "env": "GH_TOKEN", "value": "ghp_a" } oops');
	assert.match(log, /cannot read the secrets from stdin/);
	assert.equal(log.includes("ghp_a"), false, log);
});

/** A data directory holding a policy for `api-abc123`, for this test only. */
async function sandboxWithPolicy(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "playpen-helper-"));
	const before = {
		XDG_DATA_HOME: process.env.XDG_DATA_HOME,
		LIMA_HOME: process.env.LIMA_HOME,
	};
	process.env.XDG_DATA_HOME = join(root, "data");
	process.env.LIMA_HOME = join(root, "lima");
	t.after(async () => {
		// Assigning undefined would leave the string "undefined" behind.
		Object.entries(before).forEach(([name, value]) => {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		});
		await rm(root, { recursive: true, force: true });
	});
	await writePolicy("api-abc123", {
		allow: [],
		mode: "enforce",
		ports: [],
		secrets: [{ env: "GH_TOKEN", hosts: ["api.github.com"] }],
	});
	return root;
}

/**
 * A `PATH` whose only `bwrap` and `socat` wait and do nothing, so a helper
 * gets as far as writing its record and then waits for a VM that never comes.
 * Nothing else is on it, so no `limactl` can be reached.
 */
async function idlePath(root: string): Promise<string> {
	const bin = join(root, "bin");
	await mkdir(bin);
	await Promise.all(
		["bwrap", "socat"].map((name) =>
			writeFile(join(bin, name), "#!/bin/sh\nexec /bin/sleep 5\n", {
				mode: 0o755,
			}),
		),
	);
	return bin;
}

async function recordOnceWritten(path: string): Promise<string> {
	for (;;) {
		const text = await readFile(path, "utf8").catch(() => undefined);
		if (text !== undefined) return text;
		await sleep(100);
	}
}

test("a helper records the names of its secrets in helper.json, and no value", {
	timeout: 10_000,
}, async (t) => {
	const root = await sandboxWithPolicy(t);
	const helper = spawn(
		process.execPath,
		[cliPath(), "__net-helper", "api-abc123", "playpen-api-abc123"],
		{
			env: { ...process.env, PATH: await idlePath(root) },
			stdio: ["pipe", "ignore", "ignore"],
		},
	);
	t.after(() => helper.kill());
	helper.stdin.end(JSON.stringify([{ env: "GH_TOKEN", value: "ghp_a" }]));

	const record = await recordOnceWritten(fencePaths("api-abc123").helper);

	assert.deepEqual(JSON.parse(record).secrets, ["GH_TOKEN"]);
	assert.equal(record.includes("ghp_a"), false, record);
});
