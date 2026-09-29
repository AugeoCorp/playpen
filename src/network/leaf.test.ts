import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, type TestContext, test } from "node:test";
import tls from "node:tls";
import forge from "node-forge";
import { type Ca, ensureCa } from "./ca.ts";
import { type ContextFor, leafMinter } from "./leaf.ts";

let ca: Ca;
let dataHome: string;
const savedDataHome = process.env.XDG_DATA_HOME;

before(async () => {
	dataHome = await mkdtemp(join(tmpdir(), "playpen-leaf-"));
	process.env.XDG_DATA_HOME = dataHome;
	ca = await ensureCa();
});

after(async () => {
	if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = savedDataHome;
	await rm(dataHome, { recursive: true, force: true });
});

/**
 * The certificate a client asking for `host` is served, over a real TLS
 * handshake that verifies it against the CA and checks it names `host`: the
 * handshake failing is the test failing. A test that sets the minter's clock
 * passes `verify: false`, since the handshake checks validity against the
 * real one.
 */
async function served(
	t: TestContext,
	contextFor: ContextFor,
	host: string,
	{ verify = true }: { verify?: boolean } = {},
): Promise<X509Certificate> {
	const server = tls.createServer({
		SNICallback: (name, done) => done(null, contextFor(name)),
	});
	server.on("secureConnection", (socket) => socket.end());
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	t.after(() => new Promise<void>((r) => server.close(() => r())));
	const { port } = server.address() as AddressInfo;
	return new Promise((resolve, reject) => {
		const socket = tls.connect(
			{
				host: "127.0.0.1",
				port,
				servername: host,
				ca: ca.certPem,
				rejectUnauthorized: verify,
			},
			() => {
				const cert = socket.getPeerX509Certificate();
				socket.destroy();
				if (cert === undefined) reject(new Error("no peer certificate"));
				else resolve(cert);
			},
		);
		socket.on("error", reject);
	});
}

function keyIdentifierIn(extension: unknown): string {
	const der = (extension as { value: string }).value;
	const sequence = forge.asn1.fromDer(der).value as forge.asn1.Asn1[];
	return forge.util.bytesToHex(sequence[0]?.value as string);
}

test("a client that trusts the CA accepts the certificate served for a host", async (t) => {
	const cert = await served(t, leafMinter(ca), "api.github.com");
	const caCert = new X509Certificate(ca.certPem);
	assert.ok(cert.checkIssued(caCert), "not issued by the playpen CA");
	assert.ok(cert.verify(caCert.publicKey), "not signed by the CA's key");
});

test("the certificate names the host in its subject and its alternative names", async (t) => {
	const cert = await served(t, leafMinter(ca), "api.github.com");
	assert.equal(cert.subject, "CN=api.github.com");
	assert.equal(cert.subjectAltName, "DNS:api.github.com");
});

test("the certificate is for a server and cannot sign other certificates", async (t) => {
	const cert = await served(t, leafMinter(ca), "api.github.com");
	// `X509Certificate.ca` is false for a CA:TRUE certificate whose key usage
	// lacks keyCertSign, so the extension itself is read too.
	const basicConstraints = forge.pki
		.certificateFromPem(cert.toString())
		.getExtension("basicConstraints") as { cA?: boolean } | undefined;
	assert.equal(basicConstraints?.cA, false);
	assert.equal(cert.ca, false);
	assert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.1"]);
});

test("the certificate names the CA's key as its issuer's, which strict clients require", async (t) => {
	const cert = forge.pki.certificateFromPem(
		(await served(t, leafMinter(ca), "api.github.com")).toString(),
	);
	const caCert = forge.pki.certificateFromPem(ca.certPem);
	const ski = caCert.getExtension("subjectKeyIdentifier") as {
		subjectKeyIdentifier: string;
	};
	assert.equal(
		keyIdentifierIn(cert.getExtension("authorityKeyIdentifier")),
		ski.subjectKeyIdentifier,
	);
});

test("the certificate is valid for seven days, from a minute before it was minted, so a guest clock running a little slow accepts it", async (t) => {
	const minted = Date.parse("2026-09-01T00:00:00Z");
	const cert = await served(
		t,
		leafMinter(ca, () => minted),
		"api.github.com",
		{ verify: false },
	);
	assert.deepEqual(
		{ validFrom: new Date(cert.validFrom), validTo: new Date(cert.validTo) },
		{
			validFrom: new Date("2026-08-31T23:59:00Z"),
			validTo: new Date("2026-09-08T00:00:00Z"),
		},
	);
});

test("the same host is served the same certificate on every connection", async (t) => {
	const contextFor = leafMinter(ca);
	const first = await served(t, contextFor, "api.github.com");
	const second = await served(t, contextFor, "api.github.com");
	assert.equal(second.serialNumber, first.serialNumber);
});

test("a different host is served a certificate of its own", async (t) => {
	const contextFor = leafMinter(ca);
	const github = await served(t, contextFor, "api.github.com");
	const npm = await served(t, contextFor, "registry.npmjs.org");
	assert.notEqual(npm.serialNumber, github.serialNumber);
	assert.equal(npm.subjectAltName, "DNS:registry.npmjs.org");
});

test("a certificate within a day of its end is replaced by a new one", async (t) => {
	let now = Date.parse("2026-09-01T00:00:00Z");
	const contextFor = leafMinter(ca, () => now);
	const first = await served(t, contextFor, "api.github.com", {
		verify: false,
	});
	now = Date.parse("2026-09-07T12:00:00Z");
	const second = await served(t, contextFor, "api.github.com", {
		verify: false,
	});
	assert.notEqual(second.serialNumber, first.serialNumber);
	assert.equal(Date.parse(second.validTo), Date.parse("2026-09-14T12:00:00Z"));
});
