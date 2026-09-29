import assert from "node:assert/strict";
import { type ChildProcess, spawn as spawnReal } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fsReal from "node:fs/promises";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, type TestContext, test } from "node:test";
import { owner, self } from "../session/proc.ts";
import type { Policy } from "./policy.ts";

const SANDBOX = "api-abc123";
const INSTANCE = "playpen-api-abc123";
const NOTHING_ALLOWED: Policy = {
	allow: [],
	mode: "enforce",
	ports: [],
	secrets: [],
};

/** How many helpers `bringUp` has spawned in this process. */
let helpersStarted = 0;

/**
 * Stands in for the helper process `bringUp` spawns, doing what the real one
 * does first: refuse to run beside a live helper, otherwise report the VM up.
 */
function startHelper(): EventEmitter {
	helpersStarted++;
	const child = Object.assign(new EventEmitter(), { unref() {} });
	void (async () => {
		if ((await fence.liveHelper(SANDBOX)) !== null) {
			child.emit("exit", 1);
			return;
		}
		await fence.writeHelper(SANDBOX, {
			...(await self()),
			gatekeeperPort: 2,
			ready: true,
			egress: true,
			policy: "",
		});
	})();
	return child;
}

mock.module("node:child_process", {
	// @ts-expect-error @types/node still types this as `namedExports`, which the
	// runtime has deprecated. Delete this line once the types catch up.
	exports: { spawn: startHelper },
});

/** Processes that read as running in the fence's network namespace, not ours. */
const fenced = new Set<number>();

mock.module("node:fs/promises", {
	// @ts-expect-error @types/node still types this as `namedExports`, which the
	// runtime has deprecated. Delete this line once the types catch up.
	exports: {
		...fsReal,
		async readlink(path: string) {
			const pid = /^\/proc\/(\d+)\/ns\/net$/.exec(path)?.[1];
			if (pid !== undefined && fenced.has(Number(pid))) return "net:[fence]";
			return fsReal.readlink(path);
		},
	},
});

const fence = await import("./fence.ts");

/** No qemu.pid under an empty Lima home, so the sandbox reads as stopped. */
async function stoppedSandbox(t: TestContext): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "playpen-bringup-"));
	const before = {
		XDG_DATA_HOME: process.env.XDG_DATA_HOME,
		LIMA_HOME: process.env.LIMA_HOME,
	};
	process.env.XDG_DATA_HOME = join(root, "data");
	process.env.LIMA_HOME = join(root, "lima");
	helpersStarted = 0;
	t.after(async () => {
		// Assigning undefined would leave the string "undefined" behind.
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	await mkdir(fence.fencePaths(SANDBOX).dir, { recursive: true });
}

/**
 * A helper from an earlier start, still running. pid 1 always exists, so its
 * record reads as live until it is deleted.
 */
async function earlierHelper(fields: {
	ready: boolean;
	policy?: string;
}): Promise<void> {
	const init = await owner(1);
	assert.ok(init, "cannot read pid 1, which stands in for the earlier helper");
	await fence.writeHelper(SANDBOX, {
		...init,
		gatekeeperPort: 1,
		egress: true,
		policy: "",
		...fields,
	});
}

/**
 * What the earlier helper's boot leaves once it finishes: a qemu in the
 * fence's namespace named by Lima's qemu.pid, and the helper's record saying
 * ready with the policy `bringUp` has just written.
 */
async function earlierHelperBringsTheVmUp(t: TestContext): Promise<void> {
	const qemu: ChildProcess = spawnReal(
		process.execPath,
		["-e", "setInterval(() => {}, 60_000)"],
		{ argv0: "qemu-system-x86_64", stdio: "ignore" },
	);
	t.after(() => qemu.kill("SIGKILL"));
	const pid = qemu.pid;
	assert.ok(pid, "could not start the stand-in qemu");
	fenced.add(pid);
	const dir = join(process.env.LIMA_HOME ?? "", INSTANCE);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "qemu.pid"), `${pid}\n`);
	await earlierHelper({
		ready: true,
		policy: await fence.policyStamp(SANDBOX),
	});
}

function start(timeoutMs: number): Promise<void> {
	return fence.bringUp({
		sandbox: SANDBOX,
		instance: INSTANCE,
		policy: NOTHING_ALLOWED,
		mounts: { project: tmpdir(), masked: [] },
		log: () => {},
		timeoutMs,
	});
}

test("a VM started just after it stopped waits for its last helper to shut down, and is up only when its own helper says so", async (t) => {
	await stoppedSandbox(t);
	await earlierHelper({ ready: true });
	const shutdown = setTimeout(
		() => void unlink(fence.fencePaths(SANDBOX).helper),
		500,
	);
	t.after(() => clearTimeout(shutdown));

	await start(10_000);

	const up = await fence.liveHelper(SANDBOX);
	assert.equal(
		up?.pid,
		process.pid,
		`bringUp returned while the helper recorded was pid ${up?.pid}, not the one it started`,
	);
});

test("a start that finds an interrupted start's helper still booting the VM waits for that boot, and starts no second helper", async (t) => {
	await stoppedSandbox(t);
	await earlierHelper({ ready: false });
	const booted = setTimeout(() => void earlierHelperBringsTheVmUp(t), 500);
	t.after(() => clearTimeout(booted));

	await start(5_000);

	assert.equal(helpersStarted, 0, "bringUp started a helper of its own");
});

test("an earlier helper that neither exits nor brings the VM up fails the start, and says how to stop it", async (t) => {
	await stoppedSandbox(t);
	await earlierHelper({ ready: true });
	await assert.rejects(
		start(1_000),
		/earlier network helper for api-abc123 \(pid 1\) has neither exited nor brought its VM up.*stop it with: kill 1$/s,
	);
});
