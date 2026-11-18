import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, type TestContext, test } from "node:test";

const SANDBOX = "api-abc123";
const INSTANCE = "playpen-api-abc123";

/** Every command the helper spawned, as argv. */
const spawned: string[][] = [];

/** A child that has already exited, so the helper gives up on the VM at once. */
function exitedChild(): EventEmitter {
	const child = Object.assign(new EventEmitter(), { kill() {} });
	child.on("newListener", (event: string, listener: () => void) => {
		if (event === "exit") setImmediate(listener);
	});
	return child;
}

mock.module("node:child_process", {
	// @ts-expect-error @types/node still types this as `namedExports`, which the
	// runtime has deprecated. Delete this line once the types catch up.
	exports: {
		spawn(command: string, args: readonly string[]) {
			spawned.push([command, ...args]);
			return exitedChild();
		},
	},
});

const fence = await import("./fence.ts");
const { runHelper } = await import("./helper.ts");

/** A stopped sandbox with a policy written, and a project directory to mask in. */
async function stoppedSandbox(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "playpen-helper-"));
	const before = {
		XDG_DATA_HOME: process.env.XDG_DATA_HOME,
		LIMA_HOME: process.env.LIMA_HOME,
	};
	process.env.XDG_DATA_HOME = join(root, "data");
	process.env.LIMA_HOME = join(root, "lima");
	spawned.length = 0;
	t.after(async () => {
		Object.entries(before).forEach(([name, value]) => {
			// Assigning undefined would leave the string "undefined" behind.
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		});
		await rm(root, { recursive: true, force: true });
	});
	await fence.writePolicy(SANDBOX, {
		allow: [],
		mode: "enforce",
		ports: [],
		secrets: [],
	});
	const project = join(root, "project");
	await mkdir(project);
	return project;
}

/** What bwrap was told to bind over `path`, if anything. */
function boundOver(path: string): string | undefined {
	const bwrap = spawned.find(([command]) => command === "bwrap") ?? [];
	const at = bwrap.findIndex(
		(argument, index) => argument === path && bwrap[index - 2] === "--ro-bind",
	);
	return at === -1 ? undefined : bwrap[at - 1];
}

test("qemu is given an empty file in place of a masked file", async (t) => {
	const project = await stoppedSandbox(t);
	await writeFile(join(project, ".env"), "SECRET=1\n");
	await runHelper(SANDBOX, INSTANCE, [join(project, ".env")]);
	const { placeholderFile } = fence.fencePaths(SANDBOX);
	assert.equal(boundOver(join(project, ".env")), placeholderFile);
	assert.equal(await readFile(placeholderFile, "utf8"), "");
});

test("qemu is given an empty directory in place of a masked directory", async (t) => {
	const project = await stoppedSandbox(t);
	await mkdir(join(project, "secrets"));
	await writeFile(join(project, "secrets", "key"), "SECRET\n");
	await runHelper(SANDBOX, INSTANCE, [join(project, "secrets")]);
	const { placeholderDirectory } = fence.fencePaths(SANDBOX);
	assert.equal(boundOver(join(project, "secrets")), placeholderDirectory);
	assert.deepEqual(await readdir(placeholderDirectory), []);
});

test("a masked path missing on the host is not bound, so bwrap does not create it", async (t) => {
	const project = await stoppedSandbox(t);
	await runHelper(SANDBOX, INSTANCE, [join(project, "node_modules")]);
	assert.equal(boundOver(join(project, "node_modules")), undefined);
});

test("a masked path inside another masked directory is covered by that directory's bind alone", async (t) => {
	const project = await stoppedSandbox(t);
	await mkdir(join(project, "config"));
	await writeFile(join(project, "config", "secret"), "SECRET\n");
	await runHelper(SANDBOX, INSTANCE, [
		join(project, "config"),
		join(project, "config", "secret"),
	]);
	assert.equal(boundOver(join(project, "config", "secret")), undefined);
});

test("a masked path that is neither a file nor a directory is not bound", async (t) => {
	await stoppedSandbox(t);
	await runHelper(SANDBOX, INSTANCE, ["/dev/null"]);
	assert.equal(boundOver("/dev/null"), undefined);
});

test("a masked symlink fails the start before anything is spawned", async (t) => {
	const project = await stoppedSandbox(t);
	await writeFile(join(project, "real.env"), "SECRET=1\n");
	await symlink("real.env", join(project, ".env"));
	await assert.rejects(
		runHelper(SANDBOX, INSTANCE, [join(project, ".env")]),
		/\.env is reached through a symlink/,
	);
	assert.deepEqual(spawned, []);
});

test("a masked path under a symlinked directory fails the start before anything is spawned", async (t) => {
	const project = await stoppedSandbox(t);
	await mkdir(join(project, "real"));
	await writeFile(join(project, "real", "secret"), "SECRET\n");
	await symlink("real", join(project, "config"));
	await assert.rejects(
		runHelper(SANDBOX, INSTANCE, [join(project, "config", "secret")]),
		/secret is reached through a symlink/,
	);
	assert.deepEqual(spawned, []);
});
