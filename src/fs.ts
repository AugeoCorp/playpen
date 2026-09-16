import { rename, stat, writeFile } from "node:fs/promises";

export async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Write a file so no reader can ever see it half-written.
 *
 * `writeFile` creates the file and then fills it, so a concurrent reader can
 * catch it existing and empty. Callers here parse what they read and treat
 * unparseable as junk to delete, which would make that window destroy a live
 * lease. `rename` within a directory is atomic, so the file appears complete or
 * not at all.
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, data, "utf8");
	await rename(temp, path);
}
