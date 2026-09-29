import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { hostDir, makeHostDir, PREPARE_GUEST } from "./history.ts";

test("a sandbox's history directory is named after it", () => {
	assert.ok(hostDir("playpen-90957d").endsWith("/history/playpen-90957d"));
});

test("a name that could escape the history directory is refused", () => {
	for (const name of [
		"../escape",
		"/etc/passwd",
		"has space",
		"UPPER",
		"",
		"-leading",
	]) {
		assert.throws(() => hostDir(name), /invalid sandbox name/, name);
	}
});

/**
 * A fresh clone's home as `PREPARE_GUEST` sees it, with root's part played by
 * stand-ins on PATH: `sudo` notes what it was asked to run and runs it, and
 * `mountpoint` says whether the history mount is there.
 */
async function freshClone(t: TestContext, mounted: boolean) {
	const root = await mkdtemp(join(tmpdir(), "playpen-history-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const bin = join(root, "bin");
	const sudoLog = join(root, "sudo.log");
	await mkdir(join(home, ".claude", "projects"), { recursive: true });
	await mkdir(bin);
	await writeFile(
		join(bin, "sudo"),
		`#!/bin/bash\necho "$*" >> "${sudoLog}"\nexec "$@"\n`,
		{ mode: 0o755 },
	);
	await writeFile(join(bin, "mountpoint"), `#!/bin/bash\n${mounted}\n`, {
		mode: 0o755,
	});
	const run = () =>
		spawnSync("bash", ["-c", PREPARE_GUEST], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
		});
	return { home, sudoLog, run };
}

test("a fresh clone's ~/.claude, which cloud-init made as root, is handed to the guest user", async (t) => {
	const { home, sudoLog, run } = await freshClone(t, true);
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	assert.equal(
		await readFile(sudoLog, "utf8"),
		`chown ${uid}:${gid} ${home}/.claude\n`,
	);
});

test("a guest without the history mount fails, saying so, and changes nothing", async (t) => {
	const { sudoLog, run } = await freshClone(t, false);
	const result = run();
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/\.claude\/projects is not mounted from the host/,
	);
	await assert.rejects(readFile(sudoLog, "utf8"), { code: "ENOENT" });
});

async function dataHome(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "playpen-history-data-"));
	const before = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = root;
	t.after(async () => {
		process.env.XDG_DATA_HOME = before;
		await rm(root, { recursive: true, force: true });
	});
	return root;
}

async function modeOf(path: string): Promise<string> {
	return ((await lstat(path)).mode & 0o777).toString(8);
}

test("a new history directory is readable by its owner only, under a umask that would leave it open", async (t) => {
	await dataHome(t);
	const umask = process.umask(0o022);
	t.after(() => process.umask(umask));
	assert.equal(await modeOf(await makeHostDir("playpen-90957d")), "700");
});

test("an existing history directory left open to others is closed to them again", async (t) => {
	await dataHome(t);
	const dir = hostDir("playpen-90957d");
	await mkdir(dir, { recursive: true });
	await chmod(dir, 0o755);
	await makeHostDir("playpen-90957d");
	assert.equal(await modeOf(dir), "700");
});

test("a history directory that is a link is refused, and where it leads is left alone", async (t) => {
	const root = await dataHome(t);
	const elsewhere = join(root, "elsewhere");
	await mkdir(elsewhere);
	await chmod(elsewhere, 0o755);
	const dir = hostDir("playpen-90957d");
	await mkdir(dirname(dir), { recursive: true });
	await symlink(elsewhere, dir);
	await assert.rejects(makeHostDir("playpen-90957d"), /is not a directory/);
	assert.equal(await modeOf(elsewhere), "755");
});

test("a history directory owned by someone else is refused", async (t) => {
	await dataHome(t);
	await makeHostDir("playpen-90957d");
	t.mock.method(process as { getuid: () => number }, "getuid", () => 4242);
	await assert.rejects(
		makeHostDir("playpen-90957d"),
		/owned by uid \d+, not by you/,
	);
});
