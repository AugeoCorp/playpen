import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
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
import { exists as onDisk } from "../fs.ts";
import {
	archivePath,
	hostDir,
	IMPORT_HISTORY,
	MOVE_HISTORY,
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
	const stage = join(s.dst, ".playpen-staging", "-home-me-project");
	await mkdir(stage, { recursive: true });
	await writeFile(join(stage, "two.jsonl"), "cut sho");
	await writeFile(join(stage, "stray.jsonl"), "not in the guest");
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(await tree(s.dst), await tree(s.src));
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

test("a file already on the host and newer than the guest's is kept, and named", async (t) => {
	const s = await scratch(t);
	await guestHistory(s.src);
	const onHost = join(s.dst, "-home-me-project", "one.jsonl");
	await mkdir(dirname(onHost));
	await writeFile(onHost, "resumed on the host since");
	const later = new Date(Date.now() + 3_600_000);
	await utimes(onHost, later, later);
	const result = run(s, MOVE);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(await readFile(onHost, "utf8"), "resumed on the host since");
	assert.equal(result.stdout, "-home-me-project/one.jsonl\n");
});

test("a file already on the host and older than the guest's is replaced", async (t) => {
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
	assert.equal(result.stdout, "");
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

test("an old archive is unpacked into the host directory, and nothing is left beside the guest's home", async (t) => {
	const s = await scratch(t);
	const archive = await oldArchive(s);
	const expected = await tree(join(s.home, "old", ".claude", "projects"));
	await rm(join(s.home, "old"), { recursive: true });
	const result = run(s, 'import_history "$2"', archive);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(await tree(s.dst), expected);
	assert.deepEqual(await readdir(s.home), []);
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
