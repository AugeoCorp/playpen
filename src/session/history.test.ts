import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { exists as onDisk } from "../fs.ts";
import {
	archivePath,
	hostDir,
	IMPORT_HISTORY,
	MOVE_HISTORY,
	makeHostDir,
	SETTLE,
} from "./history.ts";

test("a sandbox's history directory and its old archive are named after it", () => {
	assert.ok(hostDir("playpen-90957d").endsWith("/history/playpen-90957d"));
	assert.ok(
		archivePath("playpen-90957d").endsWith("/history/playpen-90957d.tar"),
	);
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
		assert.throws(() => archivePath(name), /invalid sandbox name/, name);
	}
});

/** Every entry under `dir`: a file's contents, a link's target, or "dir". */
async function tree(dir: string): Promise<Record<string, string>> {
	const found: Record<string, string> = {};
	for (const entry of await readdir(dir, { recursive: true })) {
		const path = join(dir, entry);
		const info = await lstat(path);
		found[entry] = info.isSymbolicLink()
			? `-> ${await readlink(path)}`
			: info.isDirectory()
				? "dir"
				: await readFile(path, "utf8");
	}
	return found;
}

interface Scratch {
	src: string;
	dst: string;
	home: string;
	/** A directory put first on PATH, for stand-ins that break one command. */
	bin: string;
}

async function scratch(t: TestContext): Promise<Scratch> {
	const root = await mkdtemp(join(tmpdir(), "playpen-history-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dirs = {
		src: join(root, "guest"),
		dst: join(root, "host"),
		home: join(root, "home"),
		bin: join(root, "bin"),
	};
	for (const dir of Object.values(dirs)) await mkdir(dir);
	return dirs;
}

/** What Claude Code leaves in `~/.claude/projects`, in miniature. */
async function guestHistory(src: string): Promise<void> {
	await mkdir(join(src, "-home-me-project", "memory"), { recursive: true });
	await writeFile(join(src, "-home-me-project", "one.jsonl"), "first session");
	await writeFile(join(src, "-home-me-project", "two.jsonl"), "x".repeat(1e6));
	await writeFile(join(src, "-home-me-project", "memory", "MEMORY.md"), "m");
	await symlink("/etc/passwd", join(src, "-home-me-project", "link"));
}

const REAL = {
	tar: execFileSync("bash", ["-c", "command -v tar"], {
		encoding: "utf8",
	}).trim(),
	mv: execFileSync("bash", ["-c", "command -v mv"], {
		encoding: "utf8",
	}).trim(),
};

async function standIn(s: Scratch, name: string, body: string): Promise<void> {
	await writeFile(join(s.bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function run(
	s: Scratch,
	call: string,
	input?: Buffer,
): { code: number | null; stdout: string; stderr: string } {
	const result = spawnSync(
		"bash",
		["-c", `${MOVE_HISTORY}\n${IMPORT_HISTORY}\n${call}`, "bash", s.src, s.dst],
		{
			encoding: "utf8",
			input,
			env: {
				...process.env,
				HOME: s.home,
				PATH: `${s.bin}:${process.env.PATH}`,
			},
		},
	);
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const MOVE = 'move_history "$1" "$2"';

test("the guest's history is copied into the host directory, links as links, and the guest's copy is left as it was", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	const before = await tree(s.src);
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(await tree(s.dst), before);
	assert.deepEqual(await tree(s.src), before);
});

test("a copy whose reading side reports an error is refused, even when what arrived matches", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	await standIn(
		s,
		"tar",
		`"${REAL.tar}" "$@"; code=$?; case " $* " in *" -cf "*) exit 2;; esac; exit $code`,
	);
	assert.notEqual(run(s, MOVE).code, 0);
	assert.equal(await onDisk(join(s.dst, "-home-me-project")), false);
});

test("a copy that differs from the guest's is refused before anything is moved", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	await standIn(
		s,
		"tar",
		`"${REAL.tar}" "$@"; code=$?; case " $* " in *" -xf "*) : > "$2/-home-me-project/two.jsonl";; esac; exit $code`,
	);
	assert.notEqual(run(s, MOVE).code, 0);
	assert.equal(await onDisk(join(s.dst, "-home-me-project")), false);
});

test("what an earlier attempt left in the staging directory never reaches the host directory", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	await writeFile(join(s.home, ".playpen-vm-id"), "this-vm");
	const stage = join(s.dst, ".playpen-staging-this-vm", "-home-me-project");
	await mkdir(stage, { recursive: true });
	await writeFile(join(stage, "two.jsonl"), "cut sho");
	await writeFile(join(stage, "stray.jsonl"), "not in the guest");
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(await tree(s.dst), await tree(s.src));
});

test("a stage another VM is filling in the same host directory is left alone", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	await writeFile(join(s.home, ".playpen-vm-id"), "this-vm");
	const theirs = join(s.dst, ".playpen-staging-that-vm", "-home-me-project");
	await mkdir(theirs, { recursive: true });
	await writeFile(join(theirs, "half.jsonl"), "half cop");
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(await readFile(join(theirs, "half.jsonl"), "utf8"), "half cop");
});

test("an attempt killed halfway through moving is finished by the next, with every file whole", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	await mkdir(join(s.src, "-home-me-other"));
	await writeFile(join(s.src, "-home-me-other", "three.jsonl"), "third");
	await standIn(s, "mv", `"${REAL.mv}" "$@"; kill -KILL "$PPID"`);
	assert.notEqual(run(s, MOVE).code, 0, "the stand-in did not interrupt it");
	await rm(join(s.bin, "mv"));
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(await tree(s.dst), await tree(s.src));
});

test("a move waits while an earlier one still holds the guest's lock, and then runs", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	const held = join(s.home, "held");
	const holder = spawn(
		"flock",
		[join(s.home, ".playpen-history.lock"), "-c", `touch "${held}"; read _`],
		{ stdio: ["pipe", "ignore", "ignore"] },
	);
	t.after(() => holder.kill());
	while (!(await onDisk(held))) await sleep(20);

	const move = spawn(
		"bash",
		["-c", `${MOVE_HISTORY}\n${MOVE}`, "bash", s.src, s.dst],
		{ env: { ...process.env, HOME: s.home }, stdio: "ignore" },
	);
	const finished = once(move, "exit");
	await sleep(300);
	assert.deepEqual(await readdir(s.dst), [], "it ran beside the earlier move");

	holder.stdin?.end();
	const [code] = await finished;
	assert.equal(code, 0);
	assert.deepEqual(await tree(s.dst), await tree(s.src));
});

/** Where the one `kept` line on stdout says the other copy went. */
function setAsideAt(s: Scratch, stdout: string): string {
	const [, path, aside] = stdout.trimEnd().split("\t");
	assert.equal(path, "-home-me-project/one.jsonl", stdout);
	return join(s.dst, aside ?? "");
}

test("a file already on the host and newer than the guest's stays in place, and the guest's is set aside, not deleted", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	const onHost = join(s.dst, "-home-me-project", "one.jsonl");
	await mkdir(dirname(onHost));
	await writeFile(onHost, "cut sho");
	const later = new Date(Date.now() + 3_600_000);
	await utimes(onHost, later, later);
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(await readFile(onHost, "utf8"), "cut sho");
	assert.equal(
		await readFile(setAsideAt(s, result.stdout), "utf8"),
		"first session",
	);
});

test("a file already on the host and older than the guest's is replaced, and set aside, not deleted", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	const onHost = join(s.dst, "-home-me-project", "one.jsonl");
	await mkdir(dirname(onHost));
	await writeFile(onHost, "stale");
	const earlier = new Date(Date.now() - 3_600_000);
	await utimes(onHost, earlier, earlier);
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(await readFile(onHost, "utf8"), "first session");
	assert.equal(await readFile(setAsideAt(s, result.stdout), "utf8"), "stale");
});

test("a link on the host where the guest has a directory is not followed, and the guest's directory is set aside", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	const elsewhere = join(s.home, "elsewhere");
	await mkdir(elsewhere);
	await symlink(elsewhere, join(s.dst, "-home-me-project"));
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(await readdir(elsewhere), []);
	const [, path, aside] = result.stdout.trimEnd().split("\t");
	assert.equal(path, "-home-me-project");
	assert.deepEqual(
		await tree(join(s.dst, aside ?? "")),
		await tree(join(s.src, "-home-me-project")),
	);
});

test("a copy as old as the one on the host but different leaves the host's in place, and is set aside, not deleted", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	const onHost = join(s.dst, "-home-me-project", "one.jsonl");
	await mkdir(dirname(onHost));
	await writeFile(onHost, "different");
	const second = new Date("2026-09-01T00:00:00Z");
	await utimes(join(s.src, "-home-me-project", "one.jsonl"), second, second);
	await utimes(onHost, second, second);
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(await readFile(onHost, "utf8"), "different");
	assert.equal(
		await readFile(setAsideAt(s, result.stdout), "utf8"),
		"first session",
	);
});

test("a copy identical to the one on the host is left alone, and not named", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	const onHost = join(s.dst, "-home-me-project", "one.jsonl");
	await mkdir(dirname(onHost));
	await writeFile(onHost, "first session");
	const later = new Date(Date.now() + 3_600_000);
	await utimes(onHost, later, later);
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout, "");
});

test("a file a live session creates just before the move puts one there is not replaced", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	await mkdir(join(s.dst, "-home-me-project"));
	await standIn(s, "mv", LIVE_SESSION_MV);
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(
		await readFile(join(s.dst, "-home-me-project", "one.jsonl"), "utf8"),
		"written by a live session\n",
	);
	assert.equal(
		await readFile(setAsideAt(s, result.stdout), "utf8"),
		"first session",
	);
});

/**
 * `mv` as it runs while Claude Code writes: just before a `mv -n` would put
 * `one.jsonl` in place, a live session creates it. Moves into
 * `.playpen-kept` are left alone.
 */
const LIVE_SESSION_MV = `case "$3" in *.playpen-kept*) ;; */one.jsonl) [ "$1" = -nT ] && echo "written by a live session" > "$3";; esac; exec "${REAL.mv}" "$@"`;

/** The `where` of each `kept` line on stdout, as a path under the host directory. */
function keptPaths(s: Scratch, stdout: string): string[] {
	return stdout
		.trimEnd()
		.split("\n")
		.map((line) => join(s.dst, line.split("\t")[2] ?? ""));
}

async function version(
	dir: string,
	text: string,
	month: string,
): Promise<void> {
	await mkdir(join(dir, "-home-me-project"), { recursive: true });
	const file = join(dir, "-home-me-project", "p.jsonl");
	await writeFile(file, text);
	const at = new Date(`2026-${month}-01T00:00:00Z`);
	await utimes(file, at, at);
}

test("three versions of one file, from the host, the guest and an old archive, all survive two moves in one run, each attempt setting aside into its own directory", async (t) => {
	const s = await scratch(t);
	await version(s.dst, "january, on the host", "01");
	await version(join(s.src, "guest"), "february, in the guest", "02");
	await version(join(s.src, "archive"), "march, in the archive", "03");
	const result = run(
		s,
		'move_history "$1/guest" "$2"\nmove_history "$1/archive" "$2"',
	);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(
		await readFile(join(s.dst, "-home-me-project", "p.jsonl"), "utf8"),
		"march, in the archive",
	);
	const [first, second] = keptPaths(s, result.stdout);
	assert.equal(await readFile(first ?? "", "utf8"), "january, on the host");
	assert.equal(await readFile(second ?? "", "utf8"), "february, in the guest");
	assert.notEqual(
		dirname(dirname(first ?? "")),
		dirname(dirname(second ?? "")),
		"two attempts set aside into one directory",
	);
});

test("a copy set aside because a live session beat the move does not replace the older copy set aside just before it", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	const onHost = join(s.dst, "-home-me-project", "one.jsonl");
	await mkdir(dirname(onHost));
	await writeFile(onHost, "stale");
	const earlier = new Date(Date.now() - 3_600_000);
	await utimes(onHost, earlier, earlier);
	await standIn(s, "mv", LIVE_SESSION_MV);
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(await readFile(onHost, "utf8"), "written by a live session\n");
	const [replaced, declined] = keptPaths(s, result.stdout);
	assert.equal(await readFile(replaced ?? "", "utf8"), "stale");
	assert.equal(await readFile(declined ?? "", "utf8"), "first session");
});

/** An archive as the archive-on-destroy scheme wrote it: `.claude/projects/...`. */
async function oldArchive(s: Scratch): Promise<Buffer> {
	const projects = join(s.home, "old", ".claude", "projects");
	await mkdir(projects, { recursive: true });
	await guestHistory(projects);
	return execFileSync(REAL.tar, [
		"-C",
		join(s.home, "old"),
		"-cf",
		"-",
		".claude/projects",
	]);
}

test("an old archive is unpacked into the host directory, and its unpacked copy is removed from the guest's home", async (t) => {
	const s = await scratch(t);
	const archive = await oldArchive(s);
	const expected = await tree(join(s.home, "old", ".claude", "projects"));
	await rm(join(s.home, "old"), { recursive: true });
	const result = run(s, 'import_history "$2"', archive);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(await tree(s.dst), expected);
	assert.deepEqual(
		(await readdir(s.home)).filter((f) => f.startsWith(".playpen-import")),
		[],
	);
});

/**
 * The guest as `SETTLE` sees it, with root's part played by stand-ins:
 * `~/.claude/projects` is the mount, and `under` what the mount hides, which
 * `mount --bind` reveals by linking to it.
 */
async function guest(
	s: Scratch,
	mounted = true,
): Promise<{ mount: string; under: string }> {
	const mount = join(s.home, ".claude", "projects");
	await mkdir(mount, { recursive: true });
	const under = join(s.src, "under");
	await mkdir(join(under, "projects"), { recursive: true });
	await standIn(s, "sudo", 'exec "$@"');
	await standIn(s, "mountpoint", mounted ? "exit 0" : "exit 1");
	await standIn(s, "mount", `rmdir "$3" && ln -s "${under}" "$3"`);
	await standIn(s, "umount", 'rm "$1" && mkdir "$1"');
	return { mount, under };
}

function settle(s: Scratch, args: readonly string[], input?: Buffer) {
	const result = spawnSync("bash", ["-c", SETTLE, "bash", ...args], {
		encoding: "utf8",
		input,
		env: { ...process.env, HOME: s.home, PATH: `${s.bin}:${process.env.PATH}` },
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("a start's takeover moves what lies under the mount into it, and says so", async (t) => {
	const s = await scratch(t);
	const { mount, under } = await guest(s);
	await guestHistory(join(under, "projects"));
	const result = settle(s, ["takeover", ""]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout, "takeover\t0\n");
	assert.deepEqual(await tree(mount), await tree(join(under, "projects")));
});

test("a guest without the history mount says so with its own exit code, and moves nothing", async (t) => {
	const s = await scratch(t);
	const { mount, under } = await guest(s, false);
	await guestHistory(join(under, "projects"));
	const result = settle(s, ["takeover", ""]);
	assert.equal(result.code, 3, result.stderr);
	assert.match(result.stderr, /is not mounted from the host/);
	assert.deepEqual(await readdir(mount), []);
});

test("a guest whose ~/.claude/projects is a symlink is refused with a clear message, and nothing moves", async (t) => {
	const s = await scratch(t);
	const { mount, under } = await guest(s);
	await guestHistory(join(under, "projects"));
	const elsewhere = join(s.home, "elsewhere");
	await mkdir(elsewhere);
	await rm(mount, { recursive: true });
	await symlink(elsewhere, mount);
	const result = settle(s, ["takeover", ""]);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /projects is a symlink/);
	assert.deepEqual(await readdir(elsewhere), []);
});

test("an old archive written short fails only the import, and the takeover still counts", async (t) => {
	const s = await scratch(t);
	const archive = await oldArchive(s);
	const { mount, under } = await guest(s);
	await mkdir(join(under, "projects", "-home-me-guest"));
	await writeFile(join(under, "projects", "-home-me-guest", "a.jsonl"), "a");
	const result = settle(
		s,
		["takeover", "archive"],
		archive.subarray(0, archive.length / 2),
	);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /^takeover\t0\nimport\t[1-9]\d*\n$/);
	assert.equal(
		await readFile(join(mount, "-home-me-guest", "a.jsonl"), "utf8"),
		"a",
	);
});

test("an old archive cut short is refused, and nothing reaches the host directory", async (t) => {
	const s = await scratch(t);
	const archive = await oldArchive(s);
	const result = run(
		s,
		'import_history "$2"',
		archive.subarray(0, archive.length / 2),
	);
	assert.notEqual(result.code, 0);
	assert.deepEqual(await readdir(s.dst), []);
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
