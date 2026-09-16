import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, type TestContext, test } from "node:test";
import { baseImage } from "../image/base.ts";
import { imageHash } from "../image/render.ts";
import { baseInstanceName } from "./identity.ts";

/** Every call the sandbox makes into the guest, in order. */
const calls: string[] = [];
/** `mock.module` refuses a second mock of the same specifier, so behaviour that
 * varies per test has to live here rather than in the fake. */
let maskExit = 0;
let limaHome = "";

mock.module("../lima/client.ts", {
	// @ts-expect-error @types/node still types this as `namedExports`, which the
	// runtime has deprecated. Delete this line once the types catch up.
	exports: {
		isRunning: () => false,
		list: async () => [
			{ name: baseInstanceName(imageHash(baseImage), "2026-09-16") },
		],
		get: async () => null,
		stop: async () => {},
		remove: async () => {},
		start: async () => {},
		async clone(_source: string, target: string) {
			await mkdir(join(limaHome, target), { recursive: true });
			await writeFile(
				join(limaHome, target, "lima.yaml"),
				'{"mounts": []}\n',
				"utf8",
			);
		},
		async runScript(_instance: string, script: string) {
			calls.push(script.includes("mount --bind") ? "apply masks" : "other");
			return { code: maskExit, stdout: "", stderr: "mask script failed" };
		},
		async shell(_i: string, _w: string, command: readonly string[]) {
			calls.push(`run ${command[2]}`);
			return 0;
		},
	},
});

async function sandboxFor(t: TestContext, config: string): Promise<unknown> {
	const root = await mkdtemp(join(tmpdir(), "playpen-lifecycle-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = join(root, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "playpen.config.js"), config, "utf8");

	const before = {
		xdg: process.env.XDG_DATA_HOME,
		lima: process.env.LIMA_HOME,
	};
	process.env.XDG_DATA_HOME = join(root, "data");
	limaHome = join(root, "lima");
	process.env.LIMA_HOME = limaHome;
	calls.length = 0;
	t.after(() => {
		process.env.XDG_DATA_HOME = before.xdg;
		process.env.LIMA_HOME = before.lima;
		maskExit = 0;
	});

	const { ensureRunning, identify } = await import("./lifecycle.ts");
	const { readConfigGraph } = await import("./configgraph.ts");
	const { pinConfig } = await import("./trust.ts");

	const sb = await identify(project);
	// Approved up front; the trust prompt is not what these test.
	await pinConfig(
		sb.sandbox,
		await readConfigGraph(project, "playpen.config.js"),
	);
	return ensureRunning(sb);
}

const BOTH = 'export default { masked: ["node_modules"], setup: ["npm ci"] };';

test("masks are applied before setup runs", async (t) => {
	await sandboxFor(t, BOTH);
	assert.deepEqual(calls, ["apply masks", "run exec </dev/null; npm ci"]);
});

test("setup is skipped when the masks it would install under failed", async (t) => {
	maskExit = 1;
	const result = (await sandboxFor(t, BOTH)) as { setupOk: boolean };
	assert.equal(result.setupOk, false);
	assert.deepEqual(calls, ["apply masks"]);
});
