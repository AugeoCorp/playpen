import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { checkMount, type GuardEnv } from "./mountguard.ts";

const ENV: GuardEnv = {
	home: "/home/e",
	protectedDirs: [
		"/home/e/.local/share/playpen",
		"/home/e/.lima",
		"/home/e/.claude",
	],
};

async function tempProject(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "playpen-guard-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("refuses the filesystem root", async () => {
	const result = await checkMount("/", ENV);
	assert.equal(result.ok, false);
	assert.match(result.reason ?? "", /filesystem root/);
});

test("refuses the home directory", async () => {
	const result = await checkMount("/home/e", ENV);
	assert.equal(result.ok, false);
	assert.match(result.reason ?? "", /home directory/);
});

test("refuses a parent of the home directory", async () => {
	const result = await checkMount("/home", ENV);
	assert.equal(result.ok, false);
	assert.match(result.reason ?? "", /contains your home/);
});

test("refuses system directories", async () => {
	const result = await checkMount("/etc", ENV);
	assert.equal(result.ok, false);
	assert.match(result.reason ?? "", /system directory/);
});

test("refuses playpen's own data directory, where config approvals live", async () => {
	const result = await checkMount("/home/e/.local/share/playpen", ENV);
	assert.equal(result.ok, false);
	assert.match(result.reason ?? "", /must not be able to write/);
});

test("refuses a directory that contains a protected one", async () => {
	const result = await checkMount("/home/e/.local", ENV);
	assert.equal(result.ok, false);
	assert.match(
		result.reason ?? "",
		/contains \/home\/e\/.local\/share\/playpen/,
	);
});

test("refuses a directory inside a protected one", async () => {
	const result = await checkMount("/home/e/.lima/playpen-api", ENV);
	assert.equal(result.ok, false);
	assert.match(result.reason ?? "", /inside \/home\/e\/.lima/);
});

test("a sibling of a protected directory is fine", async (t) => {
	const dir = await tempProject(t);
	const result = await checkMount(dir, {
		home: ENV.home,
		protectedDirs: [join(dir, "..", "unrelated")],
	});
	assert.equal(result.ok, true);
});

test("allows a project directory but warns when it is not a git repo", async (t) => {
	const dir = await tempProject(t);
	const result = await checkMount(dir, ENV);
	assert.equal(result.ok, true);
	assert.match(result.warning ?? "", /not a git repository/);
});

test("allows a git repo without warning", async (t) => {
	const dir = await tempProject(t);
	await mkdir(join(dir, ".git"));
	const result = await checkMount(dir, ENV);
	assert.equal(result.ok, true);
	assert.equal(result.warning, undefined);
});
