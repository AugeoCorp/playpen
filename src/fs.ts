import { open, rename, stat } from "node:fs/promises";

export async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function sizeOf(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

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
 * Write a file so no reader can ever see it half-written, and a crash or power
 * cut leaves the old contents or the new ones, never an empty file.
 *
 * Not `writeFile`, which creates the file and then fills it: a reader that
 * deletes what it cannot parse, as the lease reader does, would catch it empty
 * and delete a live lease. The fsync comes before the rename so that a crash
 * cannot rename in a file whose data never reached the disk.
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
	const temp = `${path}.${process.pid}.tmp`;
	const handle = await open(temp, "w");
	try {
		await handle.writeFile(data, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temp, path);
}
