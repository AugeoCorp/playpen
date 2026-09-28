import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { exists } from "../fs.ts";
import { bwrapArgv, maskBinds, portsScript, unboundIn } from "./helper.ts";

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

async function maskedProject(t: TestContext): Promise<{
	project: string;
	paths: { emptyFile: string; emptyDir: string };
}> {
	const root = await mkdtemp(join(tmpdir(), "playpen-helper-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = join(root, "project");
	await mkdir(join(project, "node_modules"), { recursive: true });
	await writeFile(join(project, ".env"), "SECRET=1\n");
	await symlink(".env", join(project, "linked"));
	return {
		project,
		paths: {
			emptyFile: join(root, "fence", "empty-file"),
			emptyDir: join(root, "fence", "empty-dir"),
		},
	};
}

test("each masked entry on the host gets a read-only bind of the placeholder of its kind", async (t) => {
	const { project, paths } = await maskedProject(t);
	const { args, bound } = await maskBinds(
		paths,
		{ project, masked: ["node_modules", ".env"] },
		() => {},
	);
	assert.deepEqual(args, [
		"--ro-bind",
		paths.emptyDir,
		join(project, "node_modules"),
		"--ro-bind",
		paths.emptyFile,
		join(project, ".env"),
	]);
	assert.deepEqual(bound, ["node_modules", ".env"]);
});

test("the placeholders are made empty, and only when something is bound", async (t) => {
	const { project, paths } = await maskedProject(t);
	await maskBinds(paths, { project, masked: ["absent"] }, () => {});
	assert.equal(await exists(paths.emptyFile), false);
	await maskBinds(
		paths,
		{ project, masked: [".env", "node_modules"] },
		() => {},
	);
	assert.equal((await readFile(paths.emptyFile)).length, 0);
	assert.deepEqual(await readdir(paths.emptyDir), []);
});

test("an entry missing on the host is skipped, since bwrap would create it on the host's disk", async (t) => {
	const { project, paths } = await maskedProject(t);
	const said: string[] = [];
	const { args, bound } = await maskBinds(
		paths,
		{ project, masked: ["absent"] },
		(line) => said.push(line),
	);
	assert.deepEqual(args, []);
	assert.deepEqual(bound, []);
	assert.deepEqual(said, [
		"masked: absent is not on the host; nothing to hide",
	]);
});

test("a symlink is skipped with a line saying so", async (t) => {
	const { project, paths } = await maskedProject(t);
	const said: string[] = [];
	const { args, bound } = await maskBinds(
		paths,
		{ project, masked: ["linked"] },
		(line) => said.push(line),
	);
	assert.deepEqual(args, []);
	assert.deepEqual(bound, []);
	assert.deepEqual(said, [
		"masked: linked is a symlink; a symlink is not masked",
	]);
});

test("one line is logged for each entry skipped, and none for one bound", async (t) => {
	const { project, paths } = await maskedProject(t);
	const said: string[] = [];
	await maskBinds(
		paths,
		{ project, masked: [".env", "absent", "linked"] },
		(l) => said.push(l),
	);
	assert.equal(said.length, 2);
});

test("the mask binds come after the root bind and before the command", () => {
	const argv = bwrapArgv(
		["--ro-bind", "/fence/empty-file", "/work/.env"],
		["--tmpfs", "/run/systemd/resolve"],
		["node", "cli.ts"],
	);
	assert.deepEqual(argv, [
		"--unshare-net",
		"--dev-bind",
		"/",
		"/",
		"--ro-bind",
		"/fence/empty-file",
		"/work/.env",
		"--tmpfs",
		"/run/systemd/resolve",
		"--die-with-parent",
		"--",
		"node",
		"cli.ts",
	]);
});
