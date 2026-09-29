import assert from "node:assert/strict";
import {
	link,
	mkdir,
	mkdtemp,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { self } from "../session/proc.ts";
import {
	boundMasks,
	classifyFence,
	fencePaths,
	liveHelper,
	looksLikeQemu,
	maskKind,
	policyStamp,
	readMounts,
	readPolicy,
	underMaskedDir,
	warnUnboundMasks,
	writeHelper,
	writeMounts,
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
	await writePolicy("api-abc123", { allow: [], mode: "enforce", ports: [] });
	assert.notEqual(await policyStamp("api-abc123"), "");
});

test("rewriting a policy with different hosts changes its stamp", async (t) => {
	await dataDir(t);
	await writePolicy("api-abc123", { allow: [], mode: "enforce", ports: [] });
	const before = await policyStamp("api-abc123");
	await writePolicy("api-abc123", {
		allow: ["example.com:443"],
		mode: "enforce",
		ports: [],
	});
	assert.notEqual(await policyStamp("api-abc123"), before);
});

test("writing a policy says whether it changed what was already on disk", async (t) => {
	await dataDir(t);
	const policy = {
		allow: ["example.com:443"],
		mode: "enforce",
		ports: [],
	} as const;
	assert.equal(await writePolicy("api-abc123", policy), true);
	assert.equal(await writePolicy("api-abc123", policy), false);
	assert.equal(
		await writePolicy("api-abc123", { allow: [], mode: "enforce", ports: [] }),
		true,
	);
});

test("the ports a policy forwards come back from policy.json as they were written", async (t) => {
	await dataDir(t);
	const policy = {
		allow: ["localhost:5000"],
		mode: "enforce",
		ports: [{ host: 5000, guest: 4321 }],
	} as const;
	await writePolicy("api-abc123", policy);
	assert.deepEqual(await readPolicy("api-abc123"), policy);
});

/** A policy.json written by hand rather than by `writePolicy`. */
async function policyWithPorts(ports: unknown): Promise<void> {
	await writePolicy("api-abc123", { allow: [], mode: "enforce", ports: [] });
	await writeFile(
		fencePaths("api-abc123").policy,
		JSON.stringify({ allow: [], mode: "enforce", ports }),
	);
}

test("a policy.json whose ports are not all port numbers is refused, since the guest runs them as root", async (t) => {
	await dataDir(t);
	await policyWithPorts([{ host: 5000, guest: "4321; reboot" }]);
	await assert.rejects(readPolicy("api-abc123"), /`ports` must be/);
	await policyWithPorts([{ host: 5000 }]);
	await assert.rejects(readPolicy("api-abc123"), /`ports` must be/);
	await policyWithPorts("5000");
	await assert.rejects(readPolicy("api-abc123"), /`ports` must be/);
});

test("a policy.json with no ports at all is refused rather than read as forwarding nothing", async (t) => {
	await dataDir(t);
	await policyWithPorts(undefined);
	await assert.rejects(readPolicy("api-abc123"), /`ports` must be/);
});

async function dirMode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

test("writePolicy leaves the fence directory readable only by its owner", async (t) => {
	await dataDir(t);
	await writePolicy("api-abc123", { allow: [], mode: "enforce", ports: [] });
	assert.equal(await dirMode(fencePaths("api-abc123").dir), 0o700);
});

test("writePolicy tightens a fence directory a previous version left world-readable", async (t) => {
	await dataDir(t);
	const { dir } = fencePaths("api-abc123");
	await mkdir(dir, { recursive: true, mode: 0o755 });
	assert.equal(await dirMode(dir), 0o755);
	await writePolicy("api-abc123", { allow: [], mode: "enforce", ports: [] });
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

test("mounts.json comes back as it was written", async (t) => {
	await dataDir(t);
	const mounts = { project: "/work/api", masked: ["node_modules", ".env"] };
	await writeMounts("api-abc123", mounts);
	assert.deepEqual(await readMounts("api-abc123"), mounts);
});

/** A mounts.json written by hand rather than by `writeMounts`. */
async function mountsFileWith(contents: unknown): Promise<void> {
	await writeMounts("api-abc123", { project: "/work/api", masked: [] });
	await writeFile(fencePaths("api-abc123").mounts, JSON.stringify(contents));
}

test("a mounts.json with a malformed key is refused, naming the key", async (t) => {
	await dataDir(t);
	await mountsFileWith({ project: "/work/api", masked: ".env" });
	await assert.rejects(readMounts("api-abc123"), /`masked`/);
	await mountsFileWith({ project: 7, masked: [] });
	await assert.rejects(readMounts("api-abc123"), /`project`/);
	await mountsFileWith({ project: "/work/api", masked: [".env", 3] });
	await assert.rejects(readMounts("api-abc123"), /`masked\.1`/);
});

test("a mounts.json missing a key, or missing altogether, is refused rather than read as masking nothing", async (t) => {
	await dataDir(t);
	await mountsFileWith({ project: "/work/api" });
	await assert.rejects(readMounts("api-abc123"), /`masked`/);
	await assert.rejects(readMounts("never-written"), /ENOENT/);
});

test("writeMounts leaves the fence directory readable only by its owner", async (t) => {
	await dataDir(t);
	await writeMounts("api-abc123", { project: "/work/api", masked: [] });
	assert.equal(await dirMode(fencePaths("api-abc123").dir), 0o700);
});

test("a helper record carries the entries it bound", async (t) => {
	await dataDir(t);
	await mkdir(fencePaths("api-abc123").dir, { recursive: true });
	await writeHelper("api-abc123", {
		...helper,
		...(await self()),
		masked: ["node_modules"],
	});
	assert.deepEqual((await liveHelper("api-abc123"))?.masked, ["node_modules"]);
});

test("a helper record from before host-side masks still reads as live, with no masked list", async (t) => {
	await dataDir(t);
	await mkdir(fencePaths("api-abc123").dir, { recursive: true });
	await writeFile(
		fencePaths("api-abc123").helper,
		JSON.stringify({ ...helper, ...(await self()) }),
	);
	const record = await liveHelper("api-abc123");
	assert.notEqual(record, null);
	assert.equal(record?.masked, undefined);
});

/** A project with a file, a directory and a symlink in it. */
async function projectDir(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "playpen-mask-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, ".env"), "SECRET=1\n");
	await mkdir(join(dir, "node_modules"));
	await symlink(".env", join(dir, "linked"));
	await symlink("node_modules", join(dir, "via"));
	return dir;
}

test("a masked entry is classed by what is on the host, without following it", async (t) => {
	const dir = await projectDir(t);
	assert.equal(await maskKind(dir, ".env"), "file");
	assert.equal(await maskKind(dir, "node_modules"), "dir");
	assert.equal(await maskKind(dir, "absent"), "missing");
	assert.equal(await maskKind(dir, ".env/inside"), "missing");
	assert.equal(await maskKind(dir, "linked"), "symlink");
	assert.equal(await maskKind(dir, "via/inside"), "under-symlink");
});

test("an entry the running helper did not bind is told to restart, and one it bound is not", async (t) => {
	const dir = await projectDir(t);
	const said: string[] = [];
	await warnUnboundMasks(
		{ project: dir, masked: ["node_modules", ".env"] },
		["node_modules"],
		(text) => said.push(text),
	);
	assert.deepEqual(said, [
		"masked: .env keeps the host's contents out after: playpen stop && playpen start\n",
	]);
});

test("an entry with nothing on the host, or a symlink, is not asked to be restarted for", async (t) => {
	const dir = await projectDir(t);
	const said: string[] = [];
	await warnUnboundMasks(
		{ project: dir, masked: ["absent", "linked", "via/inside"] },
		[],
		(text) => said.push(text),
	);
	assert.deepEqual(said, []);
});

test("an entry under a listed directory is under it, whichever is listed first", () => {
	assert.equal(
		underMaskedDir("config/secrets.json", ["config"]),
		true,
		"config/secrets.json, with config listed",
	);
	assert.equal(
		underMaskedDir("config/secrets.json", ["config/secrets.json", "config"]),
		true,
		"config/secrets.json, with itself listed before config",
	);
});

test("an entry beside a listed one, or the listed one itself, is not under it", () => {
	assert.equal(
		underMaskedDir("config", ["config/secrets.json"]),
		false,
		"config, with only a path inside it listed",
	);
	assert.equal(
		underMaskedDir("config-old/x", ["config"]),
		false,
		"config-old/x, with config listed",
	);
	assert.equal(
		underMaskedDir("config", ["config"]),
		false,
		"config, with config listed",
	);
});

test("an entry under a masked directory is not asked to be restarted for", async (t) => {
	const dir = await projectDir(t);
	await mkdir(join(dir, "config"));
	await writeFile(join(dir, "config", "secrets.json"), "{}\n");
	const said: string[] = [];
	await warnUnboundMasks(
		{ project: dir, masked: ["config/secrets.json", "config"] },
		["config"],
		(text) => said.push(text),
	);
	assert.deepEqual(said, []);
});

const QEMU = 4242;
const PROJECT = "/work/api";

/**
 * A stand-in for /proc: `<proc>/4242/root/work/api` is qemu's view of the
 * project, and the placeholders sit on the same filesystem, as they do for
 * a real bind, so a bound entry is the placeholder's own inode.
 */
async function fakeProc(t: TestContext): Promise<{
	proc: string;
	view: string;
	placeholders: { emptyFile: string; emptyDir: string };
}> {
	const root = await mkdtemp(join(tmpdir(), "playpen-proc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const proc = join(root, "proc");
	const view = join(proc, String(QEMU), "root", PROJECT);
	await mkdir(view, { recursive: true });
	const placeholders = {
		emptyFile: join(root, "fence", "empty-file"),
		emptyDir: join(root, "fence", "empty-dir"),
	};
	await mkdir(placeholders.emptyDir, { recursive: true });
	await writeFile(placeholders.emptyFile, "");
	return { proc, view, placeholders };
}

test("a masked file showing the placeholder's own inode is bound", async (t) => {
	const { proc, view, placeholders } = await fakeProc(t);
	await link(placeholders.emptyFile, join(view, ".env"));
	assert.deepEqual(
		await boundMasks(QEMU, PROJECT, [".env"], placeholders, proc),
		[".env"],
	);
});

test("a masked directory showing the placeholder's own inode is bound", async (t) => {
	const { proc, view, placeholders } = await fakeProc(t);
	await symlink(placeholders.emptyDir, join(view, "node_modules"));
	assert.deepEqual(
		await boundMasks(QEMU, PROJECT, ["node_modules"], placeholders, proc),
		["node_modules"],
	);
});

test("a masked file replaced on the host, so qemu now sees another inode there, is not bound", async (t) => {
	const { proc, view, placeholders } = await fakeProc(t);
	await link(placeholders.emptyFile, join(view, ".env"));
	await writeFile(join(view, ".env.local"), "SECRET=2\n");
	assert.deepEqual(
		await boundMasks(QEMU, PROJECT, [".env", ".env.local"], placeholders, proc),
		[".env"],
	);
});

test("a masked directory replaced by a real one is not bound", async (t) => {
	const { proc, view, placeholders } = await fakeProc(t);
	await mkdir(join(view, "node_modules"));
	assert.deepEqual(
		await boundMasks(QEMU, PROJECT, ["node_modules"], placeholders, proc),
		[],
	);
});

test("a masked entry gone from qemu's view is not bound", async (t) => {
	const { proc, placeholders } = await fakeProc(t);
	assert.deepEqual(
		await boundMasks(QEMU, PROJECT, [".env"], placeholders, proc),
		[],
	);
});

test("nothing is bound for a qemu whose /proc entry is gone", async (t) => {
	const { proc, view, placeholders } = await fakeProc(t);
	await link(placeholders.emptyFile, join(view, ".env"));
	assert.deepEqual(
		await boundMasks(9999, PROJECT, [".env"], placeholders, proc),
		[],
	);
});

test("nothing is bound when the placeholders themselves are missing", async (t) => {
	const { proc, view, placeholders } = await fakeProc(t);
	await link(placeholders.emptyFile, join(view, ".env"));
	assert.deepEqual(
		await boundMasks(
			QEMU,
			PROJECT,
			[".env"],
			{
				emptyFile: join(proc, "no-such-file"),
				emptyDir: placeholders.emptyDir,
			},
			proc,
		),
		[],
	);
});
