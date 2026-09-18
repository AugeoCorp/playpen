import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	classifyFence,
	fencePaths,
	looksLikeQemu,
	policyStamp,
	writePolicy,
} from "./fence.ts";

const OURS = "net:[4026531840]";
const THEIRS = "net:[4026532999]";

const helper = {
	pid: 42,
	start: "999",
	boot: "b",
	gatekeeperPort: 1234,
	ready: true,
	egress: true,
};

test("a sandbox's sockets and logs live together under the data directory", () => {
	const before = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = "/data";
	try {
		const paths = fencePaths("api-abc123");
		assert.equal(paths.dir, join("/data", "playpen", "net", "api-abc123"));
		assert.equal(paths.egress, join(paths.dir, "egress.sock"));
		assert.equal(paths.control, join(paths.dir, "control.sock"));
		assert.equal(paths.policy, join(paths.dir, "policy.json"));
	} finally {
		process.env.XDG_DATA_HOME = before;
	}
});

test("a sandbox name that would escape the runtime directory is refused", () => {
	for (const name of ["../evil", "a/b", "", ".", "-leading", "Upper", "a b"]) {
		assert.throws(
			() => fencePaths(name),
			/invalid sandbox name/,
			`expected ${JSON.stringify(name)} to be refused`,
		);
	}
});

test("no qemu means the sandbox is stopped, whatever else is running", () => {
	assert.equal(
		classifyFence({ guestNetNs: null, ourNetNs: OURS, helper }),
		"stopped",
	);
});

test("qemu in another network namespace with a ready helper is sealed", () => {
	assert.equal(
		classifyFence({ guestNetNs: THEIRS, ourNetNs: OURS, helper }),
		"sealed",
	);
});

test("a fenced VM whose helper died has nothing answering its egress", () => {
	assert.equal(
		classifyFence({ guestNetNs: THEIRS, ourNetNs: OURS, helper: null }),
		"sealed-no-gatekeeper",
	);
});

test("a fenced VM whose guest never reached the gatekeeper is sealed with no egress", () => {
	assert.equal(
		classifyFence({
			guestNetNs: THEIRS,
			ourNetNs: OURS,
			helper: { ...helper, egress: false },
		}),
		"sealed-no-egress",
	);
});

test("a helper that has not finished starting does not count as a gatekeeper", () => {
	assert.equal(
		classifyFence({
			guestNetNs: THEIRS,
			ourNetNs: OURS,
			helper: { ...helper, ready: false, egress: false },
		}),
		"sealed-no-gatekeeper",
	);
});

test("qemu in our own network namespace is unsealed, helper or not", () => {
	assert.equal(
		classifyFence({ guestNetNs: OURS, ourNetNs: OURS, helper }),
		"unsealed",
	);
});

/** The data directory the fence writes under, pointed somewhere disposable. */
async function dataDir(t: TestContext): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "playpen-fence-"));
	const before = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = root;
	t.after(async () => {
		process.env.XDG_DATA_HOME = before;
		await rm(root, { recursive: true, force: true });
	});
}

test("a policy that has not been written yet stamps differently from one that has", async (t) => {
	await dataDir(t);
	assert.equal(await policyStamp("api-abc123"), "");
	await writePolicy("api-abc123", { allow: [], mode: "enforce" });
	assert.notEqual(await policyStamp("api-abc123"), "");
});

test("rewriting a policy with different hosts changes its stamp", async (t) => {
	await dataDir(t);
	await writePolicy("api-abc123", { allow: [], mode: "enforce" });
	const before = await policyStamp("api-abc123");
	await writePolicy("api-abc123", {
		allow: ["example.com:443"],
		mode: "enforce",
	});
	assert.notEqual(await policyStamp("api-abc123"), before);
});

test("writing a policy says whether it changed what was already on disk", async (t) => {
	await dataDir(t);
	const policy = { allow: ["example.com:443"], mode: "enforce" } as const;
	assert.equal(await writePolicy("api-abc123", policy), true);
	assert.equal(await writePolicy("api-abc123", policy), false);
	assert.equal(
		await writePolicy("api-abc123", { allow: [], mode: "enforce" }),
		true,
	);
});

async function dirMode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

test("writePolicy leaves the fence directory readable only by its owner", async (t) => {
	await dataDir(t);
	await writePolicy("api-abc123", { allow: [], mode: "enforce" });
	assert.equal(await dirMode(fencePaths("api-abc123").dir), 0o700);
});

test("writePolicy tightens a fence directory a previous version left world-readable", async (t) => {
	await dataDir(t);
	const { dir } = fencePaths("api-abc123");
	await mkdir(dir, { recursive: true, mode: 0o755 });
	assert.equal(await dirMode(dir), 0o755);
	await writePolicy("api-abc123", { allow: [], mode: "enforce" });
	assert.equal(await dirMode(dir), 0o700);
});

test("a real qemu command line is recognized", () => {
	const cmdline = [
		"/usr/bin/qemu-system-x86_64",
		"-name",
		"lima-playpen-api-abc123",
		"-m",
		"8192",
		"",
	].join("\0");
	assert.equal(looksLikeQemu(cmdline), true);
});

test("a recycled pid now running an unrelated process is not mistaken for qemu", () => {
	assert.equal(looksLikeQemu("/usr/bin/bash\0-c\0some-script.sh\0"), false);
});

test("an empty cmdline, as a zombie or an unreadable process reads, is not qemu", () => {
	assert.equal(looksLikeQemu(""), false);
});
