import { open, rename, stat, writeFile } from "node:fs/promises";

export async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** 0 for a file that does not exist, rather than throwing. */
export async function sizeOf(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

/**
 * What a file has gained since byte offset `from`: the shared shape a helper
 * process's own log tailer and a probe scanning for one line both read
 * through, so they land on the same "half-written last line" handling.
 */
export async function readAppended(
	path: string,
	from: number,
): Promise<{ text: string; end: number }> {
	const none = { text: "", end: from };
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "r");
	} catch {
		return none;
	}
	try {
		const { size } = await handle.stat();
		if (size <= from) return none;
		const buffer = Buffer.alloc(size - from);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
		return {
			text: buffer.subarray(0, bytesRead).toString("utf8"),
			end: from + bytesRead,
		};
	} finally {
		await handle.close();
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
