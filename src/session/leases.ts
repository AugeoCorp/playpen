import { mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config.ts";
import { writeAtomic } from "../fs.ts";
import { assertSandboxName } from "./identity.ts";
import { isLive, type Owner, self } from "./proc.ts";

export type { Owner };

/**
 * One file per session attached to a sandbox, so the last one out is the one
 * that stops the VM. Without this, two `playpen claude` in a project share a
 * guest and the first to exit cuts off the second.
 *
 * Under the data directory rather than the project: a sandbox mounts only the
 * project, so nothing inside a guest can forge a lease to keep itself alive or
 * delete one to cut off a sibling.
 */
function leasesDir(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(dataDir(), "leases", sandbox);
}

export async function acquire(sandbox: string): Promise<Owner> {
	const owner = await self();
	const dir = leasesDir(sandbox);
	await mkdir(dir, { recursive: true });
	await writeAtomic(join(dir, String(owner.pid)), `${JSON.stringify(owner)}\n`);
	return owner;
}

export async function release(sandbox: string, owner: Owner): Promise<void> {
	try {
		await unlink(join(leasesDir(sandbox), String(owner.pid)));
	} catch {
		// Already gone: released twice, or cleared by `stop --force`.
	}
}

/**
 * Leases whose process is still running. A session killed outright leaves its
 * file behind, so anything dead is deleted here rather than by a reaper.
 */
export async function live(sandbox: string): Promise<Owner[]> {
	const dir = leasesDir(sandbox);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}

	const alive: Owner[] = [];
	for (const name of names) {
		const path = join(dir, name);
		let owner: Owner;
		try {
			owner = JSON.parse(await readFile(path, "utf8")) as Owner;
		} catch {
			// Written atomically, so this is corrupt rather than half-written.
			await unlink(path).catch(() => {});
			continue;
		}
		if (await isLive(owner)) alive.push(owner);
		else await unlink(path).catch(() => {});
	}
	return alive;
}

/** For `stop --force`, which cuts every session off deliberately. */
export async function clear(sandbox: string): Promise<void> {
	await rm(leasesDir(sandbox), { recursive: true, force: true });
}
