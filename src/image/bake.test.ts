import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, type TestContext, test } from "node:test";
import { instanceName, sandboxName } from "../session/identity.ts";

/** Every call the fake Lima client received, in order. */
const calls: string[] = [];
/** Whether the faked instance is up, the way `limactl start` leaves one even
 * when it failed partway through provisioning. */
let running = false;
/** Set by a test to make the fake `createAndStart` fail like a broken bake. */
let startFails = false;

mock.module("../lima/client.ts", {
	// @ts-expect-error @types/node still types this as `namedExports`, which the
	// runtime has deprecated. Delete this line once the types catch up.
	exports: {
		isRunning: (i: { status: string } | null) => i?.status === "Running",
		list: async () => [],
		get: async (name: string) => (running ? { name, status: "Running" } : null),
		async createAndStart(name: string) {
			calls.push(`createAndStart ${name}`);
			running = true;
			if (startFails) throw new Error("limactl start failed (exit 1)");
		},
		async stop(name: string, force = false) {
			calls.push(force ? `stop -f ${name}` : `stop ${name}`);
			running = false;
		},
		async remove(name: string) {
			calls.push(`remove ${name}`);
			running = false;
		},
	},
});

/** Points `templatesDir()` at a scratch directory and resets the fake Lima state. */
async function withTempData(t: TestContext): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "playpen-bake-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const before = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = dir;
	t.after(() => {
		if (before === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = before;
	});
	calls.length = 0;
	running = false;
	startFails = false;
}

test("picks the newest base for the image definition", async () => {
	const { pickBase } = await import("./bake.ts");
	const names = [
		"playpen-base-aaaaaaaa-2026-01-09",
		"playpen-base-aaaaaaaa-2026-09-15",
		"playpen-base-aaaaaaaa-2026-03-22",
	];
	assert.equal(pickBase(names, "aaaaaaaa"), "playpen-base-aaaaaaaa-2026-09-15");
});

test("ignores bases built from a different image definition", async () => {
	const { pickBase } = await import("./bake.ts");
	const names = ["playpen-base-bbbbbbbb-2026-09-15"];
	assert.equal(pickBase(names, "aaaaaaaa"), null);
});

test("ignores sandboxes, including one for a directory named base", async () => {
	const { pickBase } = await import("./bake.ts");
	const sandbox = instanceName(sandboxName("/home/e/projects/base"));
	assert.equal(
		pickBase([sandbox, "playpen-unrelated", "other-vm"], "aaaaaaaa"),
		null,
	);
});

test("no base yields null rather than an arbitrary instance", async () => {
	const { pickBase } = await import("./bake.ts");
	assert.equal(pickBase([], "aaaaaaaa"), null);
});

test("a bake that fails partway is stopped and deleted, not left looking finished", async (t) => {
	await withTempData(t);
	const { buildBase } = await import("./bake.ts");
	const { templatesDir } = await import("../config.ts");
	startFails = true;

	await assert.rejects(
		() => buildBase(new Date("2026-09-18T00:00:00Z")),
		/limactl start failed/,
	);

	const [createCall, stopCall, removeCall] = calls;
	const name = createCall?.split(" ")[1];
	assert.match(name ?? "", /^playpen-base-[0-9a-f]{8}-2026-09-18$/);
	// Stopped and deleted, in that order, rather than left running under its
	// final name where the next `image build` would call it finished.
	assert.equal(stopCall, `stop -f ${name}`);
	assert.equal(removeCall, `remove ${name}`);
	assert.equal(running, false);

	// The rendered template is kept: it is the only record of what this failed
	// bake tried to build.
	const yaml = await readFile(join(templatesDir(), `${name}.yaml`), "utf8");
	assert.ok(yaml.length > 0);
});
