import assert from "node:assert/strict";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import {
	chmod,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

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

test("the key is written 0600 in a 0700 directory, and the certificate is on disk for later changes", async (t) => {
	await withTempData(t);
	const { ensureCa, caCertPath } = await import("./ca.ts");
	const { caDir } = await import("../config.ts");

	const ca = await ensureCa();
	assert.equal((await stat(join(caDir(), "ca.key"))).mode & 0o777, 0o600);
	assert.equal((await stat(caDir())).mode & 0o777, 0o700);
	assert.equal(await readFile(caCertPath(), "utf8"), ca.certPem);
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

test("a certificate that does not belong to the key is refused rather than baked into an image", async (t) => {
	await withTempData(t);
	const { ensureCa } = await import("./ca.ts");
	const { caDir } = await import("../config.ts");
	await ensureCa();
	const keyPath = join(caDir(), "ca.key");
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	await writeFile(
		keyPath,
		privateKey.export({ type: "pkcs1", format: "pem" }),
		{ mode: 0o600 },
	);

	await assert.rejects(ensureCa, /does not match/);
});
