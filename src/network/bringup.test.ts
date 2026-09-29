import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
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

/**
 * Stands in for the helper process `bringUp` spawns, doing what the real one
 * does first: refuse to run beside a live helper, otherwise report the VM up.
 */
function startHelper(): EventEmitter {
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

const fence = await import("./fence.ts");

/** No qemu.pid under an empty Lima home, so the sandbox reads as stopped. */
async function stoppedSandbox(t: TestContext): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "playpen-bringup-"));
	const before = {
		xdg: process.env.XDG_DATA_HOME,
		lima: process.env.LIMA_HOME,
	};
	process.env.XDG_DATA_HOME = join(root, "data");
	process.env.LIMA_HOME = join(root, "lima");
	t.after(async () => {
		process.env.XDG_DATA_HOME = before.xdg;
		process.env.LIMA_HOME = before.lima;
		await rm(root, { recursive: true, force: true });
	});
	await mkdir(fence.fencePaths(SANDBOX).dir, { recursive: true });
}

/**
 * The helper from the VM's last run, not yet aware the VM is gone. pid 1
 * always exists, so its record reads as live until it is deleted.
 */
async function lastRunsHelperStillUp(): Promise<void> {
	const init = await owner(1);
	assert.ok(init, "cannot read pid 1, which stands in for the last helper");
	await fence.writeHelper(SANDBOX, {
		...init,
		gatekeeperPort: 1,
		ready: true,
		egress: false,
		policy: "",
	});
}

function start(timeoutMs: number): Promise<void> {
	return fence.bringUp({
		sandbox: SANDBOX,
		instance: INSTANCE,
		policy: NOTHING_ALLOWED,
		log: () => {},
		timeoutMs,
	});
}

test("a VM started just after it stopped waits for its last helper to shut down, and is up only when its own helper says so", async (t) => {
	await stoppedSandbox(t);
	await lastRunsHelperStillUp();
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

test("a last helper that never shuts down fails the start and is named, rather than being taken for the new one", async (t) => {
	await stoppedSandbox(t);
	await lastRunsHelperStillUp();
	await assert.rejects(
		start(1_000),
		/network helper for api-abc123 \(pid 1\) is still running with its VM stopped/,
	);
});
