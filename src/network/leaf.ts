import { generateKeyPairSync } from "node:crypto";
import { createSecureContext, type SecureContext } from "node:tls";
import forge from "node-forge";
import { type Ca, newCertificate } from "./ca.ts";

export type ContextFor = (host: string) => SecureContext;

/**
 * Server certificates for the hosts the interceptor terminates TLS for, signed
 * by the install's CA and valid as long as it is. One key serves every host
 * for the life of the process, and never leaves it.
 */
export function leafMinter(ca: Ca): ContextFor {
	const caCert = forge.pki.certificateFromPem(ca.certPem);
	const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
	const { subjectKeyIdentifier } = caCert.getExtension(
		"subjectKeyIdentifier",
	) as { subjectKeyIdentifier: string };
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const keyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

	// Signing in forge took 42 ms a certificate when measured, on the event
	// loop every tunnel shares, so a host's certificate is made once.
	const minted = new Map<string, SecureContext>();
	return (host) => {
		const cached = minted.get(host);
		if (cached !== undefined) return cached;
		const cert = newCertificate(publicKey, caCert.validity.notAfter);
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
			// Python 3.13's default context verifies with VERIFY_X509_STRICT, under
			// which OpenSSL refuses a leaf that does not name its issuer's key:
			// https://docs.python.org/3/library/ssl.html#ssl.create_default_context
			{
				name: "authorityKeyIdentifier",
				keyIdentifier: forge.util.hexToBytes(subjectKeyIdentifier),
			},
		]);
		cert.sign(caKey, forge.md.sha256.create());
		const context = createSecureContext({
			key: keyPem,
			cert: `${forge.pki.certificateToPem(cert)}${ca.certPem}`,
		});
		minted.set(host, context);
		return context;
	};
}
