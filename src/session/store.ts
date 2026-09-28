import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionsDir } from "../config.ts";
import { assertSandboxName } from "./identity.ts";

export interface SessionMeta {
	name: string;
	cwd: string;
	created: string;
	lastUsed: string;
	imageHash: string;
	/** Base this sandbox was cloned from. The image hash is what decides staleness. */
	baseInstance?: string;
	pinned?: boolean;
	/** Fingerprint of the ~/.claude subset last copied in; skips unchanged re-pushes. */
	configHash?: string;
}

/**
 * Names also arrive derived from Lima instance names, not only from
 * `sandboxName()`, and this value is joined into a path that gets unlinked.
 */
function metaPath(name: string): string {
	assertSandboxName(name, "session");
	return join(sessionsDir(), `${name}.json`);
}

export async function save(meta: SessionMeta): Promise<void> {
	await mkdir(sessionsDir(), { recursive: true });
	await writeFile(
		metaPath(meta.name),
		`${JSON.stringify(meta, null, 2)}\n`,
		"utf8",
	);
}

export async function load(name: string): Promise<SessionMeta | null> {
	try {
		const raw = await readFile(metaPath(name), "utf8");
		return JSON.parse(raw) as SessionMeta;
	} catch {
		// Lima, not this file, is the source of truth for whether the VM exists.
		return null;
	}
}

export async function all(): Promise<SessionMeta[]> {
	try {
		const files = await readdir(sessionsDir());
		const metas = await Promise.all(
			files
				.filter((f) => f.endsWith(".json"))
				.map((f) => load(f.slice(0, -".json".length))),
		);
		return metas.filter((m): m is SessionMeta => m !== null);
	} catch {
		return [];
	}
}

export async function remove(name: string): Promise<void> {
	try {
		await unlink(metaPath(name));
	} catch {
		// Already gone.
	}
}

export async function touch(name: string): Promise<void> {
	const meta = await load(name);
	if (!meta) return;
	meta.lastUsed = new Date().toISOString();
	await save(meta);
}
