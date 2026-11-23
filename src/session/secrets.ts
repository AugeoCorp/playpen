import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { validateHeaderValue } from "node:http";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { HeldSecret } from "../network/fence.ts";
import {
	placeholderFor,
	type SecretGrant,
	secretNames,
} from "../network/policy.ts";

/** Run as root in the guest with `placeholderProfile` on stdin. */
export const PROFILE_SCRIPT = "cat > /etc/profile.d/playpen-secrets.sh";

/**
 * Takes each granted variable's value out of `env`, every one before any is
 * checked, so no child spawned afterwards inherits it, even after a refusal.
 * A variable unset or empty there is read from `envFiles` instead. Every
 * command needs every variable, even when a helper is already running with the
 * values.
 */
export function takeSecretValues(
	grants: readonly SecretGrant[],
	env: NodeJS.ProcessEnv,
	envFiles: NodeJS.Dict<string>,
): HeldSecret[] {
	const names = secretNames(grants);
	const held = names.map((name) => ({
		env: name,
		value: env[name] || envFiles[name] || "",
	}));
	names.forEach((name) => {
		delete env[name];
	});
	const missing = held
		.filter((secret) => secret.value === "")
		.map((secret) => secret.env);
	if (missing.length > 0) {
		throw new Error(
			`network.secrets needs ${missing.join(", ")} set in your environment, ${ENV_FILES.toReversed().join(" or ")}`,
		);
	}
	held.forEach((secret) => {
		assertFitsHeader(secret.env, secret.value);
	});
	return held;
}

/** A later file wins: `.env.local` is this machine's own, `.env` is shared. */
const ENV_FILES = [".env", ".env.local"];

/** The variables the project's `.env` and `.env.local` set, parsed and never run. */
export async function readEnvFiles(
	project: string,
): Promise<NodeJS.Dict<string>> {
	const parsed = await Promise.all(
		ENV_FILES.map((name) => readEnvFile(join(project, name))),
	);
	return Object.assign({}, ...parsed);
}

/**
 * The guest can write to the project directory, so only a regular file is
 * read: a link there could point this read at any file on the host. Opened
 * without following one, and without waiting on a fifo, then checked through
 * the handle so the file read is the file checked.
 */
async function readEnvFile(path: string): Promise<NodeJS.Dict<string>> {
	let handle: FileHandle;
	try {
		handle = await open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return {};
		if (code === "ELOOP") throw notRegularFile(path);
		throw err;
	}
	try {
		if (!(await handle.stat()).isFile()) throw notRegularFile(path);
		return parseEnv(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
}

function notRegularFile(path: string): Error {
	return new Error(
		`${path} is not a regular file, so network.secrets will not read it`,
	);
}

/**
 * What the guest's login shells source: each name set to its placeholder. With
 * no names it is empty, so a secret dropped from the config leaves the guest.
 */
export function placeholderProfile(grants: readonly SecretGrant[]): string {
	return secretNames(grants)
		.map((name) => `export ${name}=${placeholderFor(name)}\n`)
		.join("");
}

function assertFitsHeader(name: string, value: string): void {
	try {
		validateHeaderValue("authorization", value);
	} catch {
		throw new Error(
			`network.secrets: ${name} holds a character that cannot go in a request header`,
		);
	}
}
