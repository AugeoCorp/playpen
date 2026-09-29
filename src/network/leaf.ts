import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createSecureContext, type SecureContext } from "node:tls";
import forge from "node-forge";
import type { Ca } from "./ca.ts";

const DAY_MS = 24 * 3600_000;
const VALID_MS = 7 * DAY_MS;

/**
 * A certificate kept this close to its end is minted again rather than served:
 * a helper lives as long as its VM, which can be longer than a week.
 */
const RENEW_MS = DAY_MS;

export type ContextFor = (host: string) => SecureContext;

/**
 * Server certificates for the hosts the interceptor terminates TLS for, signed
 * by the install's CA. One key serves every host for the life of the process;
 * one certificate per host is minted on first use and reused until it nears
 * its end.
 */
export function leafMinter(ca: Ca, now: () => number = Date.now): ContextFor {
	const caCert = forge.pki.certificateFromPem(ca.certPem);
	const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
	const ski = caCert.getExtension("subjectKeyIdentifier") as
		| { subjectKeyIdentifier?: string }
		| undefined;
	if (ski?.subjectKeyIdentifier === undefined) {
		throw new Error("the playpen CA certificate has no subject key identifier");
	}
	// Python 3.13's default context verifies with VERIFY_X509_STRICT, under
	// which OpenSSL refuses a leaf that does not name its issuer's key:
	// https://docs.python.org/3/library/ssl.html#ssl.create_default_context
	const authorityKeyId = forge.util.hexToBytes(ski.subjectKeyIdentifier);

	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const keyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
	const leafPublic = forge.pki.publicKeyFromPem(
		publicKey.export({ type: "spki", format: "pem" }).toString(),
	);

	const minted = new Map<string, { context: SecureContext; until: number }>();
	return (host) => {
		const cached = minted.get(host);
		if (cached !== undefined && cached.until - now() > RENEW_MS) {
			return cached.context;
		}
		const cert = forge.pki.createCertificate();
		cert.publicKey = leafPublic;
		// A leading 01 keeps the serial positive; RFC 5280 allows 20 octets.
		cert.serialNumber = `01${randomBytes(15).toString("hex")}`;
		const issued = now();
		// Backdated a minute so a guest with a slightly slow clock accepts it.
		cert.validity.notBefore = new Date(issued - 60_000);
		cert.validity.notAfter = new Date(issued + VALID_MS);
		cert.setSubject([{ name: "commonName", value: host }]);
		cert.setIssuer(caCert.subject.attributes);
		cert.setExtensions([
			{ name: "basicConstraints", cA: false },
			{
				name: "keyUsage",
				digitalSignature: true,
				keyEncipherment: true,
				critical: true,
			},
			{ name: "extKeyUsage", serverAuth: true },
			{ name: "subjectAltName", altNames: [{ type: 2, value: host }] },
			{ name: "authorityKeyIdentifier", keyIdentifier: authorityKeyId },
		]);
		cert.sign(caKey, forge.md.sha256.create());
		const context = createSecureContext({
			key: keyPem,
			cert: `${forge.pki.certificateToPem(cert)}${ca.certPem}`,
		});
		minted.set(host, { context, until: issued + VALID_MS });
		return context;
	};
}
