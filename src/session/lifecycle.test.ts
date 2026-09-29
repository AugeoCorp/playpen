import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, type TestContext, test } from "node:test";
import { loadBaseImage } from "../image/base.ts";
import { imageHash } from "../image/render.ts";
import type { HeldSecret } from "../network/fence.ts";
import type { Policy, PortForward } from "../network/policy.ts";
import { baseInstanceName } from "./identity.ts";
import type { Sandbox } from "./lifecycle.ts";

/** Every call the sandbox makes into the guest, in order. */
const calls: string[] = [];
/** `mock.module` refuses a second mock of the same specifier, so behaviour that
 * varies per test has to live here rather than in the fake. */
let maskExit = 0;
let limaHome = "";
/** Whether the fake has been cloned into existence yet, so `stop` has something to stop. */
let exists = false;
/** The instances the Lima fake was asked to delete. */
const removed: string[] = [];
/** What the user answers when `start` offers a rebuild. */
let rebuildAnswer = false;
/** What the fake reports for an instance that exists; a test stops it. */
let status: "Running" | "Stopped" = "Running";
/** The policy the sandbox was brought up behind, as the fence was handed it. */
let fencedWith: Policy | null = null;
/** The fake's policy.json: the last policy written, which outlives a stop. */
let policyFile: Policy | null = null;
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
/** The secrets `bringUp` was last handed, values included. */
let fencedSecrets: readonly HeldSecret[] = [];
/** Whether a helper is running: false until `bringUp` spawns one, and again when a test kills it. */
let helperLive = false;

mock.module("../network/fence.ts", {
	// @ts-expect-error @types/node still types this as `namedExports`, which the
	// runtime has deprecated. Delete this line once the types catch up.
	exports: {
		fenceStatus: async () => (exists ? fenceState : "stopped"),
		liveHelper: async () =>
			helperLive
				? {
						pid: 1,
						start: "1",
						boot: "b",
						gatekeeperPort: 1080,
						ready: true,
						egress: helperEgress,
						unboundPorts: helperUnbound,
						policy: "1:2",
					}
				: null,
		// Like the real one, which reads back the policy.json `bringUp` wrote.
		async readPolicy() {
			if (policyFile === null) throw new Error("no policy.json");
			return policyFile;
		},
		// Like the real one: the policy is written whatever state the fence is
		// in, and a sandbox that is already up behind a gatekeeper is left where
		// it is rather than started a second time.
		async bringUp(opts: { policy: Policy; secrets?: readonly HeldSecret[] }) {
			fencedWith = opts.policy;
			fencedSecrets = opts.secrets ?? [];
			policyFile = opts.policy;
			const up = fenceState === "sealed" || fenceState === "sealed-no-egress";
			if (fenced && up) {
				calls.push("leave the fence alone");
				return;
			}
			fenced = true;
			helperLive = true;
			calls.push("start behind the gatekeeper");
		},
	},
});

mock.module("../prompt.ts", {
	// @ts-expect-error @types/node still types this as `namedExports`, which the
	// runtime has deprecated. Delete this line once the types catch up.
	exports: { confirm: async () => rebuildAnswer },
});

mock.module("../lima/client.ts", {
	// @ts-expect-error @types/node still types this as `namedExports`, which the
	// runtime has deprecated. Delete this line once the types catch up.
	exports: {
		isRunning: (i: { status: string } | null) => i?.status === "Running",
		list: async () => [
			{
				name: baseInstanceName(imageHash(await loadBaseImage()), "2026-09-16"),
			},
		],
		get: async (name: string) => (exists ? { name, status } : null),
		stop: async () => {
			calls.push("stop");
		},
		async remove(name: string) {
			removed.push(name);
		},
		async clone(_source: string, target: string) {
			exists = true;
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
	removed.length = 0;
	rebuildAnswer = false;
	exists = false;
	fencedWith = null;
	policyFile = null;
	fenceState = "sealed";
	helperEgress = true;
	helperUnbound = [];
	fenced = false;
	fencedSecrets = [];
	helperLive = false;
	status = "Running";
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

/** Sets variables for one test, and puts back whatever was there. */
function setEnv(t: TestContext, vars: Record<string, string | undefined>) {
	for (const [name, value] of Object.entries(vars)) {
		const before = process.env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
		t.after(() => {
			if (before === undefined) delete process.env[name];
			else process.env[name] = before;
		});
	}
}

const TOKEN = "ghp_correct-horse-battery-staple";
const ONE_SECRET =
	'export default { network: { secrets: [{ env: "PLAYPEN_TEST_TOKEN", hosts: ["api.github.com"] }] } };';

const BOTH = 'export default { masked: ["node_modules"], setup: ["npm ci"] };';

test("masks are applied before setup runs", async (t) => {
	const { run } = await sandboxFor(t, BOTH);
	await run();
	assert.deepEqual(calls, [
		"start behind the gatekeeper",
		"apply masks",
		"run exec </dev/null; npm ci",
	]);
});

test("setup is skipped when the masks it would install under failed", async (t) => {
	maskExit = 1;
	const { run } = await sandboxFor(t, BOTH);
	const result = (await run()) as { setupOk: boolean };
	assert.equal(result.setupOk, false);
	assert.deepEqual(calls, ["start behind the gatekeeper", "apply masks"]);
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

test("the boot that saves a stopped sandbox's history carries the secret grants it was last started with, and allows nothing", async (t) => {
	setEnv(t, { PLAYPEN_TEST_TOKEN: TOKEN });
	const { sb, run } = await sandboxFor(t, ONE_SECRET);
	await run();
	const { destroy } = await import("./lifecycle.ts");
	status = "Stopped";
	fenced = false;
	fencedWith = null;
	await destroy(sb);
	assert.deepEqual(fencedWith, {
		allow: [],
		mode: "enforce",
		ports: [],
		secrets: [{ env: "PLAYPEN_TEST_TOKEN", hosts: ["api.github.com"] }],
	});
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
	setEnv(t, { GH_TOKEN: "ghp_a", NPM_TOKEN: "npm_a" });
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
	setEnv(t, { PLAYPEN_TEST_TOKEN: "ghp_not-to-be-printed" });
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

test("a start with secrets whose variables are unset is refused, naming every one, and nothing is booted", async (t) => {
	setEnv(t, {
		PLAYPEN_TEST_A: undefined,
		PLAYPEN_TEST_B: "",
		PLAYPEN_TEST_C: TOKEN,
	});
	const { run } = await sandboxFor(
		t,
		'export default { network: { secrets: [{ env: "PLAYPEN_TEST_A", hosts: ["a.example.com"] }, { env: "PLAYPEN_TEST_B", hosts: ["b.example.com"] }, { env: "PLAYPEN_TEST_C", hosts: ["c.example.com"] }] } };',
	);
	await assert.rejects(run(), (err: Error) => {
		assert.equal(
			err.message,
			"network.secrets needs PLAYPEN_TEST_A and PLAYPEN_TEST_B set in your environment",
		);
		return true;
	});
	assert.deepEqual(calls, []);
	assert.equal(fencedWith, null);
});

test("a running sandbox whose helper is gone needs the variables again, and is left as it was when they are unset", async (t) => {
	setEnv(t, { PLAYPEN_TEST_TOKEN: TOKEN });
	const { run } = await sandboxFor(t, ONE_SECRET);
	await run();
	calls.length = 0;
	fenceState = "sealed-no-gatekeeper";
	helperLive = false;
	delete process.env.PLAYPEN_TEST_TOKEN;
	await assert.rejects(run(), /network\.secrets needs PLAYPEN_TEST_TOKEN/);
	assert.deepEqual(calls, []);
});

test("a rebuild the user confirmed is refused when a variable is unset, and the old sandbox is kept", async (t) => {
	setEnv(t, { PLAYPEN_TEST_TOKEN: TOKEN });
	const { sb, run } = await sandboxFor(t, ONE_SECRET);
	await run();
	calls.length = 0;
	const { templatesDir } = await import("../config.ts");
	await writeFile(join(templatesDir(), `${sb.sandbox}.yaml`), "older\n");
	rebuildAnswer = true;
	delete process.env.PLAYPEN_TEST_TOKEN;
	const { missingMessage } = await import("./secrets.ts");
	await assert.rejects(run(), {
		message: missingMessage(["PLAYPEN_TEST_TOKEN"]),
	});
	assert.deepEqual(removed, [], "the old sandbox was deleted");
	assert.deepEqual(calls, []);
});

test("a running sandbox with a live helper does not need the variable again", async (t) => {
	setEnv(t, { PLAYPEN_TEST_TOKEN: TOKEN });
	const { run } = await sandboxFor(t, ONE_SECRET);
	await run();
	calls.length = 0;
	delete process.env.PLAYPEN_TEST_TOKEN;
	await run();
	assert.deepEqual(calls, ["leave the fence alone"]);
});

test("the helper is handed each secret's name and value, and not its hosts", async (t) => {
	setEnv(t, { PLAYPEN_TEST_TOKEN: TOKEN });
	const { run } = await sandboxFor(t, ONE_SECRET);
	await run();
	assert.deepEqual(fencedSecrets, [
		{ env: "PLAYPEN_TEST_TOKEN", value: TOKEN },
	]);
});

test("a secret named by two entries is handed to the helper once", async (t) => {
	setEnv(t, { PLAYPEN_TEST_TOKEN: TOKEN });
	const { run } = await sandboxFor(
		t,
		'export default { network: { secrets: [{ env: "PLAYPEN_TEST_TOKEN", hosts: ["a.example.com"] }, { env: "PLAYPEN_TEST_TOKEN", hosts: ["b.example.com"] }] } };',
	);
	await run();
	assert.deepEqual(fencedSecrets, [
		{ env: "PLAYPEN_TEST_TOKEN", value: TOKEN },
	]);
});

test("the policy the fence is handed names the secret and not its value", async (t) => {
	setEnv(t, { PLAYPEN_TEST_TOKEN: TOKEN });
	const { run } = await sandboxFor(t, ONE_SECRET);
	await run();
	const policy = JSON.stringify(fencedWith);
	assert.match(policy, /PLAYPEN_TEST_TOKEN/);
	assert.equal(policy.includes(TOKEN), false, policy);
});
