import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { withLock } from "./lock.ts";
import { owner, self } from "./proc.ts";

const NAME = "demo-a1b2c3";

async function dataHome(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "playpen-lock-"));
	const before = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = dir;
	t.after(async () => {
		process.env.XDG_DATA_HOME = before;
		await rm(dir, { recursive: true, force: true });
	});
	const locks = join(dir, "playpen", "locks");
	await mkdir(locks, { recursive: true });
	return join(locks, `${NAME}.lock`);
}

test("the lock is released when the work finishes", async (t) => {
	await dataHome(t);
	assert.equal(await withLock(NAME, async () => "done"), "done");
	assert.equal(await withLock(NAME, async () => "again"), "again");
});

test("the lock is released when the work throws", async (t) => {
	await dataHome(t);
	await assert.rejects(
		withLock(NAME, async () => {
			throw new Error("boom");
		}),
		/boom/,
	);
	assert.equal(await withLock(NAME, async () => "free"), "free");
});

test("a lock held by a live process is waited for, not taken", async (t) => {
	const path = await dataHome(t);
	const init = await owner(1);
	await writeFile(path, JSON.stringify(init), "utf8");

	let waited = false;
	await assert.rejects(
		withLock(NAME, async () => "never", {
			timeoutMs: 300,
			waiting: () => {
				waited = true;
			},
		}),
		/timed out/,
	);
	assert.equal(waited, true, "should have reported that it was waiting");
});

test("a lock left behind by a dead process is broken", async (t) => {
	const path = await dataHome(t);
	const me = await self();
	// Same pid, different start time: the process that held this is gone.
	await writeFile(path, JSON.stringify({ ...me, start: "1" }), "utf8");
	assert.equal(await withLock(NAME, async () => "taken"), "taken");
});

test("a lock file that is not readable json is not treated as held", async (t) => {
	const path = await dataHome(t);
	await writeFile(path, "garbage", "utf8");
	assert.equal(await withLock(NAME, async () => "taken"), "taken");
});

test("a lock name that would escape the locks directory is rejected", async (t) => {
	await dataHome(t);
	await assert.rejects(
		() => withLock("../../etc", async () => "no"),
		/invalid lock name/,
	);
});
