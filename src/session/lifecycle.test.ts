import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, type TestContext, test } from "node:test";
import { exists as onDisk } from "../fs.ts";
import { baseImage } from "../image/base.ts";
import { imageHash } from "../image/render.ts";
import type { Policy, PortForward } from "../network/policy.ts";
import { baseInstanceName } from "./identity.ts";
import type { Sandbox } from "./lifecycle.ts";

/** Every call the sandbox makes into the guest, in order. */
const calls: string[] = [];
/** `mock.module` refuses a second mock of the same specifier, so behaviour that
 * varies per test has to live here rather than in the fake. */
let maskExit = 0;
/** The exit code of the per-boot history step in the guest. */
let settleExit = 0;
/** What the history step was handed on its stdin, when anything. */
let settleInput: Uint8Array | null = null;
let limaHome = "";
/** Whether the fake has been cloned into existence yet, so `stop` has something to stop. */
let exists = false;
/** What the fake reports for an instance that exists; a test stops it. */
let status: "Running" | "Stopped" = "Running";
/** The policy the sandbox was brought up behind, as the fence was handed it. */
let fencedWith: Policy | null = null;
/** What the fake fence reports for a running VM; a test overrides it. */
let fenceState:
	| "sealed"
	| "sealed-no-egress"
	| "sealed-no-gatekeeper"
	| "unsealed" = "sealed";
/** Whether the fake helper says the guest reached the gatekeeper. */
let helperEgress = true;
/** The ports the fake helper says nothing could listen on in the guest. */
let helperUnbound: PortForward[] = [];
/** Whether the fake fence has been brought up already in this test. */
let fenced = false;

mock.module("../network/fence.ts", {
	// @ts-expect-error @types/node still types this as `namedExports`, which the
	// runtime has deprecated. Delete this line once the types catch up.
	exports: {
		fenceStatus: async () => (exists ? fenceState : "stopped"),
		liveHelper: async () => ({
			pid: 1,
			start: "1",
			boot: "b",
			gatekeeperPort: 1080,
			ready: true,
			egress: helperEgress,
			unboundPorts: helperUnbound,
			policy: "1:2",
		}),
		// Like the real one: the policy is written whatever state the fence is
		// in, and a sandbox that is already up behind a gatekeeper is left where
		// it is rather than started a second time.
		async bringUp(opts: { policy: Policy }) {
			fencedWith = opts.policy;
			const up = fenceState === "sealed" || fenceState === "sealed-no-egress";
			if (fenced && up) {
				calls.push("leave the fence alone");
				return;
			}
			fenced = true;
			calls.push("start behind the gatekeeper");
		},
	},
});

mock.module("../lima/client.ts", {
	// @ts-expect-error @types/node still types this as `namedExports`, which the
	// runtime has deprecated. Delete this line once the types catch up.
	exports: {
		isRunning: (i: { status: string } | null) => i?.status === "Running",
		list: async () => [
			{ name: baseInstanceName(imageHash(baseImage), "2026-09-16") },
		],
		get: async (name: string) => (exists ? { name, status } : null),
		stop: async () => {
			calls.push("stop");
		},
		remove: async () => {},
		async clone(_source: string, target: string) {
			exists = true;
			await mkdir(join(limaHome, target), { recursive: true });
			await writeFile(
				join(limaHome, target, "lima.yaml"),
				'{"mounts": []}\n',
				"utf8",
			);
		},
		async runScript(
			_instance: string,
			script: string,
			opts: { input?: Uint8Array } = {},
		) {
			const step = guestStep(script);
			calls.push(step);
			if (step === "settle history") {
				settleInput = opts.input ?? null;
				return { code: settleExit, stdout: "", stderr: "tar: broken pipe" };
			}
			return { code: maskExit, stdout: "", stderr: "mask script failed" };
		},
		async shell(_i: string, _w: string, command: readonly string[]) {
			calls.push(`run ${command[2]}`);
			return 0;
		},
	},
});

function guestStep(script: string): string {
	if (script.includes('mountpoint -q "$claude/projects"'))
		return "settle history";
	if (script.includes("mount --bind")) return "apply masks";
	return "other";
}

async function sandboxFor(
	t: TestContext,
	config: string,
): Promise<{ sb: Sandbox; run: () => Promise<unknown> }> {
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
	exists = false;
	fencedWith = null;
	fenceState = "sealed";
	helperEgress = true;
	helperUnbound = [];
	fenced = false;
	status = "Running";
	t.after(() => {
		process.env.XDG_DATA_HOME = before.xdg;
		process.env.LIMA_HOME = before.lima;
		maskExit = 0;
		settleExit = 0;
		settleInput = null;
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
	return { sb, run: () => ensureRunning(sb) };
}

/** pid 1 always exists, so this is a second attached session without one. */
async function anotherSessionAttaches(sandbox: string): Promise<void> {
	const { owner } = await import("./proc.ts");
	const init = await owner(1);
	const dir = join(
		process.env.XDG_DATA_HOME ?? "",
		"playpen",
		"leases",
		sandbox,
	);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "1"), JSON.stringify(init), "utf8");
}

const BOTH = 'export default { masked: ["node_modules"], setup: ["npm ci"] };';

async function limaMounts(sb: Sandbox): Promise<unknown> {
	const yaml = await readFile(join(limaHome, sb.instance, "lima.yaml"), "utf8");
	return (JSON.parse(yaml) as { mounts: unknown }).mounts;
}

function historyDirOf(sb: Sandbox): string {
	return join(
		process.env.XDG_DATA_HOME ?? "",
		"playpen",
		"history",
		sb.sandbox,
	);
}

test("a new sandbox mounts its own host directory, writable, over the guest's ~/.claude/projects", async (t) => {
	const { sb, run } = await sandboxFor(t, BOTH);
	await run();
	assert.deepEqual(await limaMounts(sb), [
		{ location: sb.cwd, writable: true },
		{
			location: historyDirOf(sb),
			mountPoint: "{{.Home}}/.claude/projects",
			writable: true,
		},
	]);
});

test("a stopped sandbox made before history was mounted gets the mount when it next starts, without a rebuild", async (t) => {
	const { sb, run } = await sandboxFor(t, BOTH);
	await mkdir(join(limaHome, sb.instance), { recursive: true });
	await writeFile(
		join(limaHome, sb.instance, "lima.yaml"),
		`{"mounts": ${JSON.stringify([{ location: sb.cwd, writable: true }])}}\n`,
		"utf8",
	);
	exists = true;
	status = "Stopped";
	const result = (await run()) as { created: boolean };
	assert.equal(result.created, false, "the sandbox was rebuilt");
	assert.deepEqual(await limaMounts(sb), [
		{ location: sb.cwd, writable: true },
		{
			location: historyDirOf(sb),
			mountPoint: "{{.Home}}/.claude/projects",
			writable: true,
		},
	]);
});

/** An archive as the archive-on-destroy scheme left it; its bytes are opaque here. */
async function oldArchiveFor(sb: Sandbox, bytes: string): Promise<string> {
	const dir = join(process.env.XDG_DATA_HOME ?? "", "playpen", "history");
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${sb.sandbox}.tar`);
	await writeFile(path, bytes);
	return path;
}

test("an archive from before the mount is handed to the guest, then kept as .imported.tar", async (t) => {
	const { sb, run } = await sandboxFor(t, BOTH);
	const archive = await oldArchiveFor(sb, "old history");
	await run();
	assert.equal(Buffer.from(settleInput ?? []).toString(), "old history");
	assert.equal(await onDisk(archive), false, "the .tar is still there");
	assert.equal(
		await readFile(archive.replace(/\.tar$/, ".imported.tar"), "utf8"),
		"old history",
	);
});

test("an archive the guest failed to import stays where it was, for the next start", async (t) => {
	const { sb, run } = await sandboxFor(t, BOTH);
	const archive = await oldArchiveFor(sb, "old history");
	settleExit = 2;
	const said = t.mock.method(console, "error", () => {});
	await run();
	assert.equal(await readFile(archive, "utf8"), "old history");
	assert.equal(
		await onDisk(archive.replace(/\.tar$/, ".imported.tar")),
		false,
		"the archive was set aside although the import failed",
	);
	const lines = said.mock.calls.map((c) => String(c.arguments[0])).join("\n");
	assert.match(lines, /Claude history is not on the host \(tar: broken pipe\)/);
});

test("an archive imported earlier is not overwritten by the next one", async (t) => {
	const { sb, run } = await sandboxFor(t, BOTH);
	const archive = await oldArchiveFor(sb, "newer");
	const earlier = archive.replace(/\.tar$/, ".imported.tar");
	await writeFile(earlier, "earlier");
	await run();
	assert.equal(await readFile(earlier, "utf8"), "earlier");
	const kept = (await readdir(dirname(archive))).filter((f) =>
		f.startsWith(`${sb.sandbox}.imported-`),
	);
	assert.equal(kept.length, 1, `expected one more kept archive, got ${kept}`);
});

test("a running sandbox is left alone when there is no archive to import", async (t) => {
	const { run } = await sandboxFor(t, BOTH);
	await run();
	calls.length = 0;
	await run();
	assert.equal(calls.includes("settle history"), false, calls.join(", "));
});

test("the host's history directory is readable by its owner only", async (t) => {
	const { sb, run } = await sandboxFor(t, BOTH);
	await run();
	const mode = (await stat(historyDirOf(sb))).mode & 0o777;
	assert.equal(mode.toString(8), "700");
});

test("masks are applied before setup runs", async (t) => {
	const { run } = await sandboxFor(t, BOTH);
	await run();
	assert.deepEqual(calls, [
		"start behind the gatekeeper",
		"apply masks",
		"settle history",
		"run exec </dev/null; npm ci",
	]);
});

test("setup is skipped when the masks it would install under failed", async (t) => {
	maskExit = 1;
	const { run } = await sandboxFor(t, BOTH);
	const result = (await run()) as { setupOk: boolean };
	assert.equal(result.setupOk, false);
	assert.deepEqual(calls, [
		"start behind the gatekeeper",
		"apply masks",
		"settle history",
	]);
});

test("a sandbox already running behind its gatekeeper is not started again", async (t) => {
	const { run } = await sandboxFor(t, BOTH);
	await run();
	calls.length = 0;
	await run();
	assert.deepEqual(calls, ["leave the fence alone", "apply masks"]);
});

test("a sandbox already running is handed the project's policy again, so a tightened list decides its next connections", async (t) => {
	const { run } = await sandboxFor(
		t,
		'export default { network: { allow: ["example.com"] } };',
	);
	await run();
	fencedWith = null;
	await run();
	const { BUILTIN_ALLOW } = await import("../network/policy.ts");
	assert.deepEqual(fencedWith, {
		allow: [...BUILTIN_ALLOW, "example.com"],
		mode: "enforce",
		ports: [],
		secrets: [],
	});
});

test("destroying a stopped sandbox boots it inside the fence with nothing allowed, to save its history", async (t) => {
	const { sb, run } = await sandboxFor(t, BOTH);
	await run();
	const { destroy } = await import("./lifecycle.ts");
	status = "Stopped";
	fenced = false;
	fencedWith = null;
	calls.length = 0;
	await destroy(sb);
	assert.deepEqual(fencedWith, {
		allow: [],
		mode: "enforce",
		ports: [],
		secrets: [],
	});
	assert.equal(calls[0], "start behind the gatekeeper");
});

test("a sandbox running with no gatekeeper gets one back", async (t) => {
	const { run } = await sandboxFor(t, BOTH);
	await run();
	calls.length = 0;
	fenceState = "sealed-no-gatekeeper";
	await run();
	assert.deepEqual(calls, ["start behind the gatekeeper", "apply masks"]);
});

test("a sandbox whose guest cannot reach the gatekeeper is started, with a warning", async (t) => {
	const { run } = await sandboxFor(t, BOTH);
	helperEgress = false;
	const warnings = t.mock.method(console, "error", () => {});
	await run();
	const said = warnings.mock.calls
		.map((c) => String(c.arguments[0]))
		.join("\n");
	assert.match(said, /has no network/);
	assert.match(said, /systemctl status playpen-tun2proxy/);
	assert.ok(
		calls.includes("start behind the gatekeeper"),
		`expected the sandbox to be started anyway, got ${calls.join(", ")}`,
	);
});

test("a sandbox already running without egress warns again instead of restarting it", async (t) => {
	const { run } = await sandboxFor(t, BOTH);
	await run();
	calls.length = 0;
	helperEgress = false;
	fenceState = "sealed-no-egress";
	const warnings = t.mock.method(console, "error", () => {});
	await run();
	const said = warnings.mock.calls
		.map((c) => String(c.arguments[0]))
		.join("\n");
	assert.match(said, /has no network/);
	assert.deepEqual(calls, ["leave the fence alone", "apply masks"]);
});

test("a sandbox running outside its fence is refused, not attached to", async (t) => {
	const { run } = await sandboxFor(t, BOTH);
	await run();
	fenceState = "unsealed";
	await assert.rejects(run(), /outside its network fence/);
});

test("the hosts a project names are allowed on top of the ones playpen ships", async (t) => {
	const { run } = await sandboxFor(
		t,
		'export default { network: { allow: ["example.com"], mode: "log" } };',
	);
	await run();
	const { BUILTIN_ALLOW } = await import("../network/policy.ts");
	assert.deepEqual(fencedWith, {
		allow: [...BUILTIN_ALLOW, "example.com"],
		mode: "log",
		ports: [],
		secrets: [],
	});
});

test("a port entry brings its own localhost entry into the policy, and reaches the helper as a port", async (t) => {
	const { run } = await sandboxFor(
		t,
		'export default { network: { allow: ["example.com"], ports: [1234, { host: 5000, guest: 4321 }] } };',
	);
	await run();
	const { BUILTIN_ALLOW } = await import("../network/policy.ts");
	assert.deepEqual(fencedWith, {
		allow: [
			...BUILTIN_ALLOW,
			"example.com",
			"localhost:1234",
			"localhost:5000",
		],
		mode: "enforce",
		ports: [
			{ host: 1234, guest: 1234 },
			{ host: 5000, guest: 4321 },
		],
		secrets: [],
	});
});

test("a secret's hosts are allowed without being listed, and the secret reaches the helper's policy", async (t) => {
	const { run } = await sandboxFor(
		t,
		'export default { network: { allow: ["example.com"], secrets: [{ env: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }, { env: "NPM_TOKEN", hosts: ["registry.example.com"] }] } };',
	);
	await run();
	const { BUILTIN_ALLOW } = await import("../network/policy.ts");
	assert.deepEqual(fencedWith, {
		allow: [
			...BUILTIN_ALLOW,
			"example.com",
			"api.github.com",
			"github.com",
			"registry.example.com",
		],
		mode: "enforce",
		ports: [],
		secrets: [
			{ env: "GH_TOKEN", hosts: ["api.github.com", "github.com"] },
			{ env: "NPM_TOKEN", hosts: ["registry.example.com"] },
		],
	});
});

test("each secret is reported by name and hosts, and its value stays out of the output, so a later injector cannot print it", async (t) => {
	process.env.PLAYPEN_TEST_TOKEN = "ghp_not-to-be-printed";
	t.after(() => {
		delete process.env.PLAYPEN_TEST_TOKEN;
	});
	const { run } = await sandboxFor(
		t,
		'export default { network: { secrets: [{ env: "PLAYPEN_TEST_TOKEN", hosts: ["api.github.com", "github.com"] }] } };',
	);
	const said = t.mock.method(console, "error", () => {});
	await run();
	const lines = said.mock.calls.map((c) => String(c.arguments[0]));
	assert.ok(
		lines.includes(
			"naming PLAYPEN_TEST_TOKEN for api.github.com, github.com (not injected yet)",
		),
		`expected a naming line, got:\n${lines.join("\n")}`,
	);
	assert.equal(
		lines.some((line) => line.includes("ghp_not-to-be-printed")),
		false,
		"the value appeared in the output",
	);
});

test("a bad secret fails the config load, so the sandbox starts with no project policy", async (t) => {
	const { run } = await sandboxFor(
		t,
		'export default { network: { allow: ["example.com"], secrets: [{ env: "gh_token", hosts: ["github.com"] }] } };',
	);
	const said = t.mock.method(console, "error", () => {});
	await run();
	const lines = said.mock.calls.map((c) => String(c.arguments[0])).join("\n");
	assert.match(
		lines,
		/`network\.secrets\[0\]\.env` must be an environment variable name/,
	);
	assert.deepEqual(fencedWith?.secrets, []);
	assert.equal(fencedWith?.allow.includes("example.com"), false);
});

test("a guest port nothing could listen on is named in a warning, and the sandbox still starts", async (t) => {
	const { run } = await sandboxFor(
		t,
		"export default { network: { ports: [{ host: 5000, guest: 4321 }] } };",
	);
	helperUnbound = [{ host: 5000, guest: 4321 }];
	const warnings = t.mock.method(console, "error", () => {});
	await run();
	const said = warnings.mock.calls
		.map((c) => String(c.arguments[0]))
		.join("\n");
	assert.match(
		said,
		/warning: host port 5000 is not at the guest's localhost:4321/,
	);
	assert.ok(
		calls.includes("start behind the gatekeeper"),
		`expected the sandbox to be started anyway, got ${calls.join(", ")}`,
	);
});

test("the last session to detach stops the sandbox", async (t) => {
	const { sb } = await sandboxFor(t, BOTH);
	const { attached } = await import("./lifecycle.ts");
	await attached(sb as never, true, async () => {});
	assert.ok(calls.includes("stop"), `expected a stop in ${calls.join(", ")}`);
});

test("detaching leaves the sandbox running while another session is attached", async (t) => {
	const { sb } = await sandboxFor(t, BOTH);
	const { attached } = await import("./lifecycle.ts");
	await attached(sb as never, true, () => anotherSessionAttaches(sb.sandbox));
	assert.deepEqual(
		calls.filter((c) => c === "stop"),
		[],
	);
});

test("a session that asked to keep the sandbox does not stop it", async (t) => {
	const { sb } = await sandboxFor(t, BOTH);
	const { attached } = await import("./lifecycle.ts");
	await attached(sb as never, false, async () => {});
	assert.deepEqual(
		calls.filter((c) => c === "stop"),
		[],
	);
});
