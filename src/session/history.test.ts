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
 * A guest's home as `PREPARE_GUEST` sees it, with its commands played by
 * stand-ins on PATH: `sudo` only notes what it was asked to run, `mountpoint`
 * says whether the history mount is there, and `id` says who the guest user
 * is. `~/.claude` is owned by whoever runs the test, so a guest user with
 * another uid finds it owned by someone else, as it finds root's.
 */
async function guest(
	t: TestContext,
	opts: { mounted: boolean; guestUid: string },
) {
	const root = await mkdtemp(join(tmpdir(), "playpen-history-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const bin = join(root, "bin");
	const sudoLog = join(root, "sudo.log");
	await mkdir(join(home, ".claude", "projects"), { recursive: true });
	await mkdir(bin);
	const standIn = (name: string, body: string) =>
		writeFile(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	await standIn("sudo", `echo "$*" >> "${sudoLog}"`);
	await standIn("mountpoint", String(opts.mounted));
	await standIn("id", `echo "${opts.guestUid}"`);
	const run = () =>
		spawnSync("bash", ["-c", PREPARE_GUEST], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
		});
	return { home, sudoLog, run };
}

const TEST_RUNNER = String(process.getuid?.());

test("a ~/.claude owned by someone other than the guest user, as cloud-init leaves it, is handed to the guest user", async (t) => {
	const { home, sudoLog, run } = await guest(t, {
		mounted: true,
		guestUid: "4242",
	});
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		await readFile(sudoLog, "utf8"),
		`chown 4242:4242 ${home}/.claude\n`,
	);
});

test("a ~/.claude the guest user already owns is left alone, without sudo", async (t) => {
	const { sudoLog, run } = await guest(t, {
		mounted: true,
		guestUid: TEST_RUNNER,
	});
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	await assert.rejects(readFile(sudoLog, "utf8"), { code: "ENOENT" });
});

test("a guest without the history mount fails, saying so, and changes nothing", async (t) => {
	const { sudoLog, run } = await guest(t, {
		mounted: false,
		guestUid: "4242",
	});
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

test("an existing history directory keeps what is already in it", async (t) => {
	await dataHome(t);
	const dir = hostDir("playpen-90957d");
	await mkdir(join(dir, "-home-me-project"), { recursive: true });
	await writeFile(join(dir, "-home-me-project", "one.jsonl"), "first session");
	await makeHostDir("playpen-90957d");
	assert.equal(
		await readFile(join(dir, "-home-me-project", "one.jsonl"), "utf8"),
		"first session",
	);
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
