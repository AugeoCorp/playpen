import {
	createPrivateKey,
	generateKeyPairSync,
	randomBytes,
	X509Certificate,
} from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { caDir } from "../config.ts";
import { writeAtomic } from "../fs.ts";

export interface Ca {
	certPem: string;
	keyPem: string;
}

export function caCertPath(): string {
	return join(caDir(), "ca.crt");
}

function caKeyPath(): string {
	return join(caDir(), "ca.key");
}

const VALID_YEARS = 10;

/**
 * Deliberately carries no name constraints: the hosts a project may name in
 * `network.secrets` differ per project and change over time, while this CA is
 * one per install, so a list fixed at creation could not name them.
 */
function createCa(): Ca {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const keyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
	const cert = forge.pki.createCertificate();
	cert.publicKey = forge.pki.publicKeyFromPem(
		publicKey.export({ type: "spki", format: "pem" }).toString(),
	);
	// A leading 01 keeps the serial positive; RFC 5280 allows 20 octets.
	cert.serialNumber = `01${randomBytes(15).toString("hex")}`;
	// Backdated a minute so a guest with a slightly slow clock accepts it.
	const now = Date.now();
	cert.validity.notBefore = new Date(now - 60_000);
	const notAfter = new Date(now);
	notAfter.setFullYear(notAfter.getFullYear() + VALID_YEARS);
	cert.validity.notAfter = notAfter;
	const name = [{ name: "commonName", value: `playpen ${hostname()}` }];
	cert.setSubject(name);
	cert.setIssuer(name);
	cert.setExtensions([
		{
			name: "basicConstraints",
			cA: true,
			pathLenConstraint: 0,
			critical: true,
		},
		{ name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
		{ name: "subjectKeyIdentifier" },
	]);
	cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
	// forge ends lines with CRLF; the certificate goes into a shell script.
	const certPem = forge.pki.certificateToPem(cert).replaceAll("\r\n", "\n");
	return { certPem, keyPem };
}

async function readIfPresent(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/**
 * The install's certificate authority, created on first use. The key stays in
 * the data directory at 0600 and never goes into the guest; the certificate is
 * public.
 */
export async function ensureCa(): Promise<Ca> {
	const keyPath = caKeyPath();
	const certPath = caCertPath();

	try {
		const { mode } = await stat(keyPath);
		if (mode & 0o077) {
			throw new Error(
				`${keyPath} is readable by other users (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it, or delete the ca directory to start over`,
			);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	const keyPem = await readIfPresent(keyPath);
	const certPem = await readIfPresent(certPath);
	if (keyPem !== null && certPem !== null) {
		// Two processes racing on first use can each write half of a pair.
		const cert = new X509Certificate(certPem);
		if (!cert.checkPrivateKey(createPrivateKey(keyPem))) {
			throw new Error(
				`${certPath} does not match ${keyPath}; delete the ca directory to start over`,
			);
		}
		return { certPem, keyPem };
	}

	const ca = createCa();
	await mkdir(caDir(), { recursive: true, mode: 0o700 });
	// Key first: a reader that finds the certificate can rely on the key existing.
	await writeAtomic(keyPath, ca.keyPem, 0o600);
	await writeAtomic(certPath, ca.certPem);
	return ca;
}
