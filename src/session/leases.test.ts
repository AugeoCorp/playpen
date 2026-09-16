import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import * as leases from "./leases.ts";
import { owner, self } from "./proc.ts";

const SANDBOX = "demo-a1b2c3";

async function dataHome(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "playpen-leases-"));
	const before = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = dir;
	t.after(async () => {
		process.env.XDG_DATA_HOME = before;
		await rm(dir, { recursive: true, force: true });
	});
	const dir_ = join(dir, "playpen", "leases", SANDBOX);
	await mkdir(dir_, { recursive: true });
	return dir_;
}

/** pid 1 always exists, so this is a second session without spawning one. */
async function anotherLiveSession(dir: string): Promise<void> {
	const init = await owner(1);
	assert.ok(init, "pid 1 should always be running");
	await writeFile(join(dir, "1"), JSON.stringify(init), "utf8");
}

test("no sandbox has been attached to yet", async (t) => {
	await dataHome(t);
	assert.deepEqual(await leases.live(SANDBOX), []);
});

test("an acquired lease is counted, and a released one is not", async (t) => {
	await dataHome(t);
	const me = await leases.acquire(SANDBOX);
	assert.equal((await leases.live(SANDBOX)).length, 1);
	await leases.release(SANDBOX, me);
	assert.deepEqual(await leases.live(SANDBOX), []);
});

test("two sessions are both counted", async (t) => {
	const dir = await dataHome(t);
	await leases.acquire(SANDBOX);
	await anotherLiveSession(dir);
	assert.equal((await leases.live(SANDBOX)).length, 2);
});

test("a lease left by a killed session is not counted, and is deleted", async (t) => {
	const dir = await dataHome(t);
	const me = await self();
	// Same pid, different start time: what a recycled pid looks like.
	await writeFile(
		join(dir, "4242"),
		JSON.stringify({ ...me, pid: 4242 }),
		"utf8",
	);
	assert.deepEqual(await leases.live(SANDBOX), []);
	assert.deepEqual(await readdir(dir), []);
});

test("an unreadable lease is discarded rather than throwing", async (t) => {
	const dir = await dataHome(t);
	await writeFile(join(dir, "7"), "not json", "utf8");
	assert.deepEqual(await leases.live(SANDBOX), []);
});

test("releasing twice is not an error", async (t) => {
	await dataHome(t);
	const me = await leases.acquire(SANDBOX);
	await leases.release(SANDBOX, me);
	await leases.release(SANDBOX, me);
	assert.deepEqual(await leases.live(SANDBOX), []);
});

test("clear cuts every session off at once", async (t) => {
	const dir = await dataHome(t);
	await leases.acquire(SANDBOX);
	await anotherLiveSession(dir);
	await leases.clear(SANDBOX);
	assert.deepEqual(await leases.live(SANDBOX), []);
});

test("a sandbox name that would escape the leases directory is rejected", async (t) => {
	await dataHome(t);
	await assert.rejects(() => leases.live("../../etc"), /invalid sandbox name/);
});
