import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { checkMount, checkReadOnlyMount, type GuardEnv } from "./mountguard.ts";

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

/** A home with a project and a sibling checkout in it, and playpen's data dir. */
async function tempHome(t: TestContext) {
	const home = await realpath(
		await mkdtemp(join(tmpdir(), "playpen-guard-home-")),
	);
	t.after(() => rm(home, { recursive: true, force: true }));
	const project = join(home, "src", "api");
	const sibling = join(home, "src", "shared-lib");
	const data = join(home, ".local", "share", "playpen");
	for (const dir of [project, sibling, data])
		await mkdir(dir, { recursive: true });
	const env: GuardEnv = { home, protectedDirs: [data] };
	return { home, project, sibling, data, env };
}

test("a read-only mount relative to the project resolves to the real directory", async (t) => {
	const { project, sibling, env } = await tempHome(t);
	assert.deepEqual(await checkReadOnlyMount("../shared-lib", project, env), {
		ok: true,
		path: sibling,
	});
});

test("a read-only mount starting with ~/ is found under the home directory", async (t) => {
	const { project, sibling, env } = await tempHome(t);
	assert.deepEqual(await checkReadOnlyMount("~/src/shared-lib", project, env), {
		ok: true,
		path: sibling,
	});
});

test("a read-only mount given as an absolute path is taken as written", async (t) => {
	const { project, sibling, env } = await tempHome(t);
	assert.deepEqual(await checkReadOnlyMount(sibling, project, env), {
		ok: true,
		path: sibling,
	});
});

test("a read-only mount naming another user's ~ is refused rather than read as a project path", async (t) => {
	const { project, env } = await tempHome(t);
	const result = await checkReadOnlyMount("~root/notes", project, env);
	assert.ok(!result.ok, "expected the mount to be refused");
	assert.match(result.reason, /only ~\/ is expanded/);
});

test("a read-only mount that does not exist is refused", async (t) => {
	const { project, env } = await tempHome(t);
	const result = await checkReadOnlyMount("../gone", project, env);
	assert.ok(!result.ok, "expected the mount to be refused");
	assert.match(result.reason, /does not exist/);
});

test("a read-only mount of a file is refused, since only directories can be shared", async (t) => {
	const { home, project, env } = await tempHome(t);
	await writeFile(join(home, "src", "notes.txt"), "");
	const result = await checkReadOnlyMount("../notes.txt", project, env);
	assert.ok(!result.ok, "expected the mount to be refused");
	assert.match(result.reason, /not a directory/);
});

test("a read-only mount of the home directory is refused", async (t) => {
	const { project, env } = await tempHome(t);
	const result = await checkReadOnlyMount("~", project, env);
	assert.ok(!result.ok, "expected the mount to be refused");
	assert.match(result.reason, /home directory/);
});

test("a read-only mount inside playpen's data directory is refused, because other sandboxes' history is there", async (t) => {
	const { project, env } = await tempHome(t);
	const result = await checkReadOnlyMount(
		"~/.local/share/playpen",
		project,
		env,
	);
	assert.ok(!result.ok, "expected the mount to be refused");
	assert.match(result.reason, /must not be able to read/);
});

test("a read-only mount through a symlink is judged by where the link points", async (t) => {
	const { home, project, env } = await tempHome(t);
	await symlink(join(home, ".local"), join(home, "src", "innocent"));
	const result = await checkReadOnlyMount("../innocent", project, env);
	assert.ok(!result.ok, "expected the mount to be refused");
	assert.match(result.reason, /contains .*playpen/);
});

test("a read-only mount of the project itself is refused", async (t) => {
	const { project, env } = await tempHome(t);
	const result = await checkReadOnlyMount(".", project, env);
	assert.ok(!result.ok, "expected the mount to be refused");
	assert.match(result.reason, /overlaps the project/);
});

test("a read-only mount inside the project is refused", async (t) => {
	const { project, env } = await tempHome(t);
	await mkdir(join(project, "vendor"));
	const result = await checkReadOnlyMount("vendor", project, env);
	assert.ok(!result.ok, "expected the mount to be refused");
	assert.match(result.reason, /overlaps the project/);
});

test("a read-only mount containing the project is refused", async (t) => {
	const { project, env } = await tempHome(t);
	const result = await checkReadOnlyMount("..", project, env);
	assert.ok(!result.ok, "expected the mount to be refused");
	assert.match(result.reason, /overlaps the project/);
});
