import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
 * handshake failing is the test failing.
 */
async function served(
	t: TestContext,
	contextFor: ContextFor,
	host: string,
): Promise<X509Certificate> {
	const server = tls.createServer({
		SNICallback: (name, done) => done(null, contextFor(name)),
	});
	server.on("secureConnection", (socket) => socket.end());
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const { port } = server.address() as AddressInfo;
	return new Promise<X509Certificate>((resolve, reject) => {
		const socket = tls.connect(
			{ host: "127.0.0.1", port, servername: host, ca: ca.certPem },
			() => {
				const peer = socket.getPeerX509Certificate();
				socket.destroy();
				if (peer === undefined) reject(new Error("no peer certificate"));
				else resolve(peer);
			},
		);
		socket.on("error", reject);
	});
}

function extension<Fields>(pem: string, name: string): Fields {
	return forge.pki.certificateFromPem(pem).getExtension(name) as Fields;
}

test("a client that trusts the CA accepts the certificate served for each host", async (t) => {
	const contextFor = leafMinter(ca);
	await served(t, contextFor, "api.github.com");
	await served(t, contextFor, "registry.npmjs.org");
});

test("the certificate is for a server and cannot sign other certificates", async (t) => {
	const cert = await served(t, leafMinter(ca), "api.github.com");
	assert.equal(
		extension<{ cA: boolean }>(cert.toString(), "basicConstraints").cA,
		false,
	);
	assert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.1"]);
});

test("the certificate passes OpenSSL's strict verification, which Python 3.13's default context uses", async (t) => {
	const cert = await served(t, leafMinter(ca), "api.github.com");
	await writeFile(join(dataHome, "ca.crt"), ca.certPem);
	await writeFile(join(dataHome, "leaf.pem"), cert.toString());
	const verified = spawnSync(
		"openssl",
		[
			"verify",
			"-x509_strict",
			"-CAfile",
			join(dataHome, "ca.crt"),
			join(dataHome, "leaf.pem"),
		],
		{ encoding: "utf8" },
	);
	assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`);
});

test("the certificate is valid until the CA's own end", async (t) => {
	const cert = await served(t, leafMinter(ca), "api.github.com");
	assert.equal(cert.validTo, new X509Certificate(ca.certPem).validTo);
});

test("a host is served the same certificate each time", async (t) => {
	const contextFor = leafMinter(ca);
	const first = await served(t, contextFor, "api.github.com");
	const second = await served(t, contextFor, "api.github.com");
	assert.equal(second.serialNumber, first.serialNumber);
});

test("two hosts are served different certificates", async (t) => {
	const contextFor = leafMinter(ca);
	const github = await served(t, contextFor, "api.github.com");
	const npm = await served(t, contextFor, "registry.npmjs.org");
	assert.notEqual(npm.serialNumber, github.serialNumber);
});
