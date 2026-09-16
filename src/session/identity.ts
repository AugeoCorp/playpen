import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

export const INSTANCE_PREFIX = "playpen-";

/**
 * The basename keeps it recognizable; the path hash keeps two projects with the
 * same directory name distinct. Same directory, same name, which is what makes
 * `playpen up` reattach instead of creating a second VM.
 */
export function sandboxName(cwd: string): string {
	const abs = resolve(cwd);
	const hash = createHash("sha256").update(abs).digest("hex").slice(0, 6);
	const slug =
		basename(abs)
			.toLowerCase()
			// Lima instance names allow only alphanumerics and dashes.
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 24) || "project";
	return `${slug}-${hash}`;
}

/** Prefixed so playpen never touches foreign instances. */
export function instanceName(sandbox: string): string {
	return `${INSTANCE_PREFIX}${sandbox}`;
}

/**
 * Bases carry their build date so `playpen ls` can show how old one is; it is a
 * label, not an expiry. A sandbox instance always ends in six hex characters,
 * so this shape cannot collide with one -- not even for a directory named
 * "base", whose instance would end in a six-character hash rather than a
 * two-digit day.
 */
const BASE_INSTANCE = new RegExp(
	`^${INSTANCE_PREFIX}base-([0-9a-f]{8})-(\\d{4}-\\d{2}-\\d{2})$`,
);

export function baseInstanceName(hash: string, date: string): string {
	return `${INSTANCE_PREFIX}base-${hash}-${date}`;
}

export function parseBaseInstance(
	name: string,
): { hash: string; date: string } | null {
	const match = BASE_INSTANCE.exec(name);
	if (!match) return null;
	const [, hash, date] = match;
	return hash !== undefined && date !== undefined ? { hash, date } : null;
}

export function isBaseInstance(name: string): boolean {
	return parseBaseInstance(name) !== null;
}

export function isPlaypenInstance(name: string): boolean {
	return name.startsWith(INSTANCE_PREFIX);
}

export function sandboxFromInstance(name: string): string {
	return name.slice(INSTANCE_PREFIX.length);
}
