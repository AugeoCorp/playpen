import { generateKeyPairSync } from "node:crypto";
import { createSecureContext, type SecureContext } from "node:tls";
import forge from "node-forge";
import { type Ca, newCertificate } from "./ca.ts";

const DAY_MS = 24 * 3600_000;
const VALID_MS = 7 * DAY_MS;

/**
 * A certificate kept this close to its end is minted again rather than served:
 * a helper lives as long as its VM, which can be longer than a week.
 */
const RENEW_MS = DAY_MS;

export type ContextFor = (host: string) => SecureContext;

/**
 * Server certificates for any host, signed by the install's CA, which the
 * guest trusts. One key serves every host for the life of the process; one
 * certificate per host is minted on first use and reused until it nears its
 * end.
 */
export function leafMinter(ca: Ca, now: () => number = Date.now): ContextFor {
	// Taken apart here so that what the minter keeps is the parsed key, which
	// renewal needs, and not the `Ca` with its PEM copy of it.
	const caCertPem = ca.certPem;
	const caCert = forge.pki.certificateFromPem(caCertPem);
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

	const minted = new Map<string, { context: SecureContext; until: number }>();
	return (host) => {
		const cached = minted.get(host);
		if (cached !== undefined && cached.until - now() > RENEW_MS) {
			return cached.context;
		}
		const issued = now();
		const cert = newCertificate(publicKey, issued, new Date(issued + VALID_MS));
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
			cert: `${forge.pki.certificateToPem(cert)}${caCertPem}`,
		});
		minted.set(host, { context, until: issued + VALID_MS });
		return context;
	};
}
