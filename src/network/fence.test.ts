import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { self } from "../session/proc.ts";
import {
	classifyFence,
	fencePaths,
	liveHelper,
	looksLikeQemu,
	policyStamp,
	readPolicy,
	writeHelper,
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
	policy: "1:2",
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
	await writePolicy("api-abc123", {
		allow: [],
		mode: "enforce",
		ports: [],
		secrets: [],
	});
	assert.notEqual(await policyStamp("api-abc123"), "");
});

test("rewriting a policy with different hosts changes its stamp", async (t) => {
	await dataDir(t);
	await writePolicy("api-abc123", {
		allow: [],
		mode: "enforce",
		ports: [],
		secrets: [],
	});
	const before = await policyStamp("api-abc123");
	await writePolicy("api-abc123", {
		allow: ["example.com:443"],
		mode: "enforce",
		ports: [],
		secrets: [],
	});
	assert.notEqual(await policyStamp("api-abc123"), before);
});

test("writing a policy says whether it changed what was already on disk", async (t) => {
	await dataDir(t);
	const policy = {
		allow: ["example.com:443"],
		mode: "enforce",
		ports: [],
		secrets: [],
	} as const;
	assert.equal(await writePolicy("api-abc123", policy), true);
	assert.equal(await writePolicy("api-abc123", policy), false);
	assert.equal(
		await writePolicy("api-abc123", {
			allow: [],
			mode: "enforce",
			ports: [],
			secrets: [],
		}),
		true,
	);
});

test("the ports a policy forwards come back from policy.json as they were written", async (t) => {
	await dataDir(t);
	const policy = {
		allow: ["localhost:5000"],
		mode: "enforce",
		ports: [{ host: 5000, guest: 4321 }],
		secrets: [],
	} as const;
	await writePolicy("api-abc123", policy);
	assert.deepEqual(await readPolicy("api-abc123"), policy);
});

test("the secrets a policy carries come back from policy.json as they were written", async (t) => {
	await dataDir(t);
	const policy = {
		allow: ["api.github.com", "github.com"],
		mode: "enforce",
		ports: [],
		secrets: [{ env: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }],
	} as const;
	await writePolicy("api-abc123", policy);
	assert.deepEqual(await readPolicy("api-abc123"), policy);
});

/** A policy.json written by hand rather than by `writePolicy`. */
async function policyWith(fields: {
	ports?: unknown;
	secrets?: unknown;
}): Promise<void> {
	await writePolicy("api-abc123", {
		allow: [],
		mode: "enforce",
		ports: [],
		secrets: [],
	});
	await writeFile(
		fencePaths("api-abc123").policy,
		JSON.stringify({
			allow: [],
			mode: "enforce",
			ports: [],
			secrets: [],
			...fields,
		}),
	);
}

const policyWithPorts = (ports: unknown) => policyWith({ ports });
const policyWithSecrets = (secrets: unknown) => policyWith({ secrets });

test("a policy.json whose ports are not all port numbers is refused, since the guest runs them as root", async (t) => {
	await dataDir(t);
	await policyWithPorts([{ host: 5000, guest: "4321; reboot" }]);
	await assert.rejects(
		readPolicy("api-abc123"),
		/`ports\[0\]\.guest` must be a port from 1 to 65535/,
	);
	await policyWithPorts([{ host: 5000 }]);
	await assert.rejects(
		readPolicy("api-abc123"),
		/`ports\[0\]\.guest` must be a port from 1 to 65535/,
	);
	await policyWithPorts([{ host: 0, guest: 4321 }]);
	await assert.rejects(
		readPolicy("api-abc123"),
		/`ports\[0\]\.host` must be a port from 1 to 65535/,
	);
	await policyWithPorts("5000");
	await assert.rejects(
		readPolicy("api-abc123"),
		/`ports` must be an array of \{ host, guest \}/,
	);
});

test("a policy.json with no ports at all is refused rather than read as forwarding nothing", async (t) => {
	await dataDir(t);
	await policyWithPorts(undefined);
	await assert.rejects(
		readPolicy("api-abc123"),
		/`ports` must be an array of \{ host, guest \}/,
	);
});

test("a policy.json whose secrets are malformed is refused", async (t) => {
	await dataDir(t);
	await policyWithSecrets([{ env: "gh token", hosts: ["github.com"] }]);
	await assert.rejects(
		readPolicy("api-abc123"),
		/`secrets\[0\]\.env` must be an environment variable name/,
	);
	await policyWithSecrets([{ env: "GH_TOKEN", hosts: [] }]);
	await assert.rejects(
		readPolicy("api-abc123"),
		/`secrets\[0\]\.hosts` must name at least one host/,
	);
	await policyWithSecrets([{ env: "GH_TOKEN", hosts: ["github.com:443"] }]);
	await assert.rejects(
		readPolicy("api-abc123"),
		/`secrets\[0\]\.hosts\[0\]` must be a hostname without a port/,
	);
	await policyWithSecrets([{ env: "GH_TOKEN", hosts: ["10.0.0.5"] }]);
	await assert.rejects(
		readPolicy("api-abc123"),
		/`secrets\[0\]\.hosts\[0\]` must be a hostname without a port/,
	);
	await policyWithSecrets("GH_TOKEN");
	await assert.rejects(
		readPolicy("api-abc123"),
		/`secrets` must be an array of \{ env, hosts \}/,
	);
});

test("a policy.json with no secrets at all is refused rather than read as injecting nothing", async (t) => {
	await dataDir(t);
	await policyWithSecrets(undefined);
	await assert.rejects(
		readPolicy("api-abc123"),
		/`secrets` must be an array of \{ env, hosts \}/,
	);
});

test("a running helper is found by the record it wrote", async (t) => {
	await dataDir(t);
	await mkdir(fencePaths("api-abc123").dir, { recursive: true });
	const record = { ...helper, ...(await self()) };
	await writeHelper("api-abc123", record);
	assert.deepEqual(await liveHelper("api-abc123"), record);
});

test("a helper.json that is not a helper record reads as no helper", async (t) => {
	await dataDir(t);
	await mkdir(fencePaths("api-abc123").dir, { recursive: true });
	await writeFile(
		fencePaths("api-abc123").helper,
		JSON.stringify({ ...helper, ...(await self()), ready: "yes" }),
	);
	assert.equal(await liveHelper("api-abc123"), null);
});

async function dirMode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

test("writePolicy leaves the fence directory readable only by its owner", async (t) => {
	await dataDir(t);
	await writePolicy("api-abc123", {
		allow: [],
		mode: "enforce",
		ports: [],
		secrets: [],
	});
	assert.equal(await dirMode(fencePaths("api-abc123").dir), 0o700);
});

test("writePolicy tightens a fence directory a previous version left world-readable", async (t) => {
	await dataDir(t);
	const { dir } = fencePaths("api-abc123");
	await mkdir(dir, { recursive: true, mode: 0o755 });
	assert.equal(await dirMode(dir), 0o755);
	await writePolicy("api-abc123", {
		allow: [],
		mode: "enforce",
		ports: [],
		secrets: [],
	});
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
