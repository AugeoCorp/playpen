import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sandboxHistoryDir, UNPACK } from "./history.ts";

test("a sandbox's history is kept in a directory named after it", () => {
	assert.ok(sandboxHistoryDir("playpen-90957d").endsWith("/playpen-90957d"));
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
		assert.throws(() => sandboxHistoryDir(name), /invalid sandbox name/, name);
	}
});

test("unpacking older history into a guest adds what it lacks and keeps what it has written since", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "playpen-history-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const saved = join(root, "saved", ".claude", "projects", "p");
	await mkdir(saved, { recursive: true });
	await writeFile(join(saved, "MEMORY.md"), "memory when it was saved");
	await writeFile(join(saved, "session-1.jsonl"), "first session");
	const january = new Date("2026-01-01T00:00:00Z");
	await utimes(join(saved, "MEMORY.md"), january, january);
	await utimes(join(saved, "session-1.jsonl"), january, january);
	const archive = execFileSync("tar", [
		"-C",
		join(root, "saved"),
		"-cf",
		"-",
		".claude/projects",
	]);
	const guest = join(root, "guest");
	await mkdir(join(guest, ".claude", "projects", "p"), { recursive: true });
	await writeFile(
		join(guest, ".claude", "projects", "p", "MEMORY.md"),
		"memory written since",
	);

	execFileSync("bash", ["-c", UNPACK], {
		input: archive,
		env: { ...process.env, HOME: guest },
		stdio: ["pipe", "pipe", "pipe"],
	});

	const projects = join(guest, ".claude", "projects", "p");
	assert.equal(
		await readFile(join(projects, "MEMORY.md"), "utf8"),
		"memory written since",
	);
	assert.equal(
		await readFile(join(projects, "session-1.jsonl"), "utf8"),
		"first session",
	);
});
