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
import { dirname, join } from "node:path";
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
	await mkdir(join(project, "config"));
	await writeFile(join(project, ".env"), "SECRET=1\n");
	await writeFile(join(project, "config", "secrets.json"), "{}\n");
	await symlink(".env", join(project, "linked"));
	await symlink("node_modules", join(project, "via"));
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
	const args = await maskBinds(
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
});

test("the placeholders are made only when something is bound, and a file left over is emptied", async (t) => {
	const { project, paths } = await maskedProject(t);
	await maskBinds(paths, { project, masked: ["absent"] }, () => {});
	assert.equal(await exists(paths.emptyFile), false);
	await mkdir(dirname(paths.emptyFile), { recursive: true });
	await writeFile(paths.emptyFile, "left over\n");
	await maskBinds(
		paths,
		{ project, masked: [".env", "node_modules"] },
		() => {},
	);
	assert.equal(await readFile(paths.emptyFile, "utf8"), "");
	assert.deepEqual(await readdir(paths.emptyDir), []);
});

test("an entry missing on the host is not bound, and the line says the guest will create it as a directory", async (t) => {
	const { project, paths } = await maskedProject(t);
	const said: string[] = [];
	const args = await maskBinds(paths, { project, masked: ["absent"] }, (line) =>
		said.push(line),
	);
	assert.deepEqual(args, []);
	assert.deepEqual(said, [
		"masked: absent is not on the host; the guest will create it there as an empty directory",
	]);
});

test("a nested entry missing under a directory that is there is skipped like any missing entry, so a fresh clone can start", async (t) => {
	const { project, paths } = await maskedProject(t);
	const said: string[] = [];
	const args = await maskBinds(
		paths,
		{ project, masked: ["config/other.json"] },
		(line) => said.push(line),
	);
	assert.deepEqual(args, []);
	assert.deepEqual(said, [
		"masked: config/other.json is not on the host; the guest will create it there as an empty directory",
	]);
});

test("a nested entry whose parent is gone refuses the start, since a guest can rename a parent away", async (t) => {
	const { project, paths } = await maskedProject(t);
	await assert.rejects(
		maskBinds(
			paths,
			{ project, masked: ["packages/app/node_modules"] },
			() => {},
		),
		{
			message:
				"masked: packages/app is not on the host, so packages/app/node_modules cannot be masked; restore it before starting",
		},
	);
});

test("an entry under a file refuses the start, naming the entry and the file", async (t) => {
	const { project, paths } = await maskedProject(t);
	await assert.rejects(
		maskBinds(paths, { project, masked: [".env/inside"] }, () => {}),
		{
			message:
				"masked: .env is a file on the host, so .env/inside cannot be masked; mask .env itself or remove the entry before starting",
		},
	);
});

test("a symlink refuses the start, naming the entry", async (t) => {
	const { project, paths } = await maskedProject(t);
	await assert.rejects(
		maskBinds(paths, { project, masked: ["linked"] }, () => {}),
		{
			message:
				"masked: linked is a symlink on the host; replace it with the real path before starting",
		},
	);
});

test("an entry under a symlink refuses the start, naming the entry", async (t) => {
	const { project, paths } = await maskedProject(t);
	await assert.rejects(
		maskBinds(paths, { project, masked: ["via/inside"] }, () => {}),
		{
			message:
				"masked: via/inside is under a symlink on the host; replace it with the real path before starting",
		},
	);
});

test("an entry under a masked directory is not bound, since the directory's placeholder hides it, whichever is listed first", async (t) => {
	const { project, paths } = await maskedProject(t);
	const dirBinds = ["--ro-bind", paths.emptyDir, join(project, "config")];
	assert.deepEqual(
		await maskBinds(
			paths,
			{ project, masked: ["config", "config/secrets.json"] },
			() => {},
		),
		dirBinds,
	);
	assert.deepEqual(
		await maskBinds(
			paths,
			{ project, masked: ["config/secrets.json", "config"] },
			() => {},
		),
		dirBinds,
	);
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
