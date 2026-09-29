import { generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import forge from "node-forge";
import { caDir, dataDir } from "../config.ts";

export interface Ca {
	certPem: string;
	keyPem: string;
}

const KEY_FILE = "ca.key";
const CERT_FILE = "ca.crt";

const VALID_YEARS = 10;

/**
 * An unsigned certificate for `publicKey`, issued at `issuedAt` and valid
 * until `notAfter`, with nothing else set: the CA and each leaf add their own
 * names and extensions.
 */
export function newCertificate(
	publicKey: KeyObject,
	issuedAt: number,
	notAfter: Date,
): forge.pki.Certificate {
	const cert = forge.pki.createCertificate();
	cert.publicKey = forge.pki.publicKeyFromPem(
		publicKey.export({ type: "spki", format: "pem" }).toString(),
	);
	// A leading 01 keeps the serial positive; RFC 5280 allows 20 octets.
	cert.serialNumber = `01${randomBytes(15).toString("hex")}`;
	// Backdated a minute so a guest with a slightly slow clock accepts it.
	cert.validity.notBefore = new Date(issuedAt - 60_000);
	cert.validity.notAfter = notAfter;
	return cert;
}

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
	const issuedAt = Date.now();
	const notAfter = new Date(issuedAt);
	notAfter.setFullYear(notAfter.getFullYear() + VALID_YEARS);
	const cert = newCertificate(publicKey, issuedAt, notAfter);
	// A fixed name: forge stores a common name as a PrintableString, and a host
	// name with `_` in it would give Go's parser (gh) a certificate it refuses.
	const name = [{ name: "commonName", value: "playpen sandbox CA" }];
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

/**
 * Both files, or null when the directory is not there yet. A key another user
 * could read is refused rather than used.
 */
export async function readCa(): Promise<Ca | null> {
	const keyPath = join(caDir(), KEY_FILE);
	let keyPem: string;
	try {
		keyPem = await readFile(keyPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	const { mode } = await stat(keyPath);
	if (mode & 0o077) {
		throw new Error(
			`${keyPath} is readable by other users (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it, or delete the ca directory to start over`,
		);
	}
	return { keyPem, certPem: await readFile(join(caDir(), CERT_FILE), "utf8") };
}

/**
 * The install's certificate authority, created on first use. The key stays in
 * the data directory at 0600 and never goes into the guest; the certificate is
 * public.
 *
 * The pair is built in a staging directory and published with one `rename`,
 * so two first-use callers at once cannot each end up with a different CA:
 * the rename fails for the one that comes second, and it reads the winner's.
 */
export async function ensureCa(): Promise<Ca> {
	const existing = await readCa();
	if (existing !== null) return existing;

	await mkdir(dataDir(), { recursive: true });
	const staging = await mkdtemp(join(dataDir(), "ca-"));
	const ca = createCa();
	await writeFile(join(staging, KEY_FILE), ca.keyPem, {
		mode: 0o600,
		flag: "wx",
	});
	await writeFile(join(staging, CERT_FILE), ca.certPem, { flag: "wx" });
	try {
		await rename(staging, caDir());
		return ca;
	} catch (err) {
		await rm(staging, { recursive: true, force: true });
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
		const winner = await readCa();
		if (winner === null) throw err;
		return winner;
	}
}
