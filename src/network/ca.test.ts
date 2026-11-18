import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import forge from "node-forge";

async function withTempData(t: TestContext): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "playpen-ca-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const before = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = dir;
	t.after(() => {
		if (before === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = before;
	});
}

test("the first call creates a self-signed CA and the second returns the same one", async (t) => {
	await withTempData(t);
	const { ensureCa } = await import("./ca.ts");

	const first = await ensureCa();
	const second = await ensureCa();
	assert.deepEqual(second, first);

	const cert = new X509Certificate(first.certPem);
	assert.equal(cert.ca, true);
	assert.ok(cert.checkIssued(cert));
	assert.ok(cert.verify(cert.publicKey));
});

test("the certificate is valid for about ten years", async (t) => {
	await withTempData(t);
	const { ensureCa } = await import("./ca.ts");

	const cert = new X509Certificate((await ensureCa()).certPem);
	const years =
		(Date.parse(cert.validTo) - Date.now()) / (365.25 * 24 * 3600_000);
	assert.ok(years > 9.9 && years < 10.1, `valid for ${years} years`);
	assert.ok(Date.parse(cert.validFrom) <= Date.now());
});

test("the CA can sign server certificates and nothing else, and carries the identifier its leaves will name", async (t) => {
	await withTempData(t);
	const { ensureCa } = await import("./ca.ts");

	const cert = forge.pki.certificateFromPem((await ensureCa()).certPem);
	const basic = cert.getExtension("basicConstraints") as Record<
		string,
		unknown
	>;
	assert.equal(basic.cA, true);
	assert.equal(basic.pathLenConstraint, 0);
	assert.equal(basic.critical, true);
	const usage = cert.getExtension("keyUsage") as Record<string, unknown>;
	assert.equal(usage.keyCertSign, true);
	assert.equal(usage.cRLSign, true);
	assert.equal(usage.digitalSignature, false);
	assert.equal(usage.critical, true);
	assert.ok(
		cert.getExtension("subjectKeyIdentifier"),
		"no subject key identifier",
	);
	assert.equal(cert.subject.getField("CN").value, "playpen sandbox CA");
});

test("the key is written 0600 in a 0700 directory, and the certificate is written beside it", async (t) => {
	await withTempData(t);
	const { ensureCa } = await import("./ca.ts");
	const { caDir } = await import("../config.ts");

	const ca = await ensureCa();
	assert.equal((await stat(join(caDir(), "ca.key"))).mode & 0o777, 0o600);
	assert.equal((await stat(caDir())).mode & 0o777, 0o700);
	assert.equal(await readFile(join(caDir(), "ca.crt"), "utf8"), ca.certPem);
});

test("two processes creating the CA at the same time end up with the same one", async (t) => {
	await withTempData(t);
	const script =
		'import("./src/network/ca.ts").then(async ({ ensureCa }) => process.stdout.write((await ensureCa()).certPem))';
	const run = () =>
		promisify(execFile)(
			process.execPath,
			["--input-type=module", "-e", script],
			{
				env: process.env,
			},
		);

	const [a, b] = await Promise.all([run(), run()]);
	assert.equal(a.stdout, b.stdout);
	const { ensureCa } = await import("./ca.ts");
	assert.equal((await ensureCa()).certPem, a.stdout);
});

test("a group- or world-readable key is refused, naming the file", async (t) => {
	await withTempData(t);
	const { ensureCa } = await import("./ca.ts");
	const { caDir } = await import("../config.ts");
	await ensureCa();
	const keyPath = join(caDir(), "ca.key");

	await chmod(keyPath, 0o640);
	await assert.rejects(ensureCa, (err: Error) => err.message.includes(keyPath));

	await chmod(keyPath, 0o604);
	await assert.rejects(ensureCa, (err: Error) => err.message.includes(keyPath));
});
