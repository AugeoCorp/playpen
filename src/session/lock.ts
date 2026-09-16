import {
	link,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config.ts";
import { isLive, type Owner, self } from "./proc.ts";

/**
 * Serialises deciding to stop a sandbox against attaching to one.
 *
 * Without it: a session releases its lease, sees none left, and decides to
 * stop; a second session starts, finds the VM running and attaches; the first
 * then stops it. Both halves run under this lock, so the second either arrives
 * early enough to be counted or late enough to start the VM itself.
 */
function lockPath(name: string): string {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
		throw new Error(`invalid lock name: ${JSON.stringify(name)}`);
	}
	return join(dataDir(), "locks", `${name}.lock`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Who the lock file says holds it, or null if there is no readable lock. */
async function heldBy(path: string): Promise<Owner | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Owner;
	} catch {
		return null;
	}
}

/**
 * Publish `owner` at `path`, or fail if it already exists.
 *
 * `link` rather than an `O_EXCL` write, because a write creates the file and
 * then fills it: another claimant could see it existing and empty, read no
 * holder, conclude nobody held it, and delete a live lock -- leaving two
 * processes in a critical section whose whole purpose is to hold one. The
 * contents are complete in the temporary file before the link makes them
 * visible under `path`.
 */
async function publish(path: string, owner: Owner): Promise<boolean> {
	const temp = `${path}.${owner.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(owner)}\n`, "utf8");
	try {
		await link(temp, path);
		return true;
	} catch {
		return false;
	} finally {
		await unlink(temp).catch(() => {});
	}
}

/**
 * Take the lock, or report who is holding it.
 *
 * A lock whose holder is gone is moved aside rather than unlinked in place: the
 * rename names the file, so two processes breaking the same stale lock cannot
 * both delete it and both claim. Ownership is re-read after publishing for the
 * same reason -- whoever ends up in the file is the holder, and anyone else
 * retries.
 */
async function claim(path: string, owner: Owner): Promise<boolean> {
	if (await publish(path, owner)) {
		return isMine(await heldBy(path), owner);
	}

	const holder = await heldBy(path);
	// Written atomically, so an unreadable lock is corrupt, not half-written;
	// leaving it would wedge the sandbox permanently.
	if (holder === null || !(await isLive(holder))) {
		await rename(path, `${path}.${owner.pid}.stale`)
			.then(() => unlink(`${path}.${owner.pid}.stale`))
			.catch(() => {});
	}
	return false;
}

function isMine(holder: Owner | null, owner: Owner): boolean {
	return (
		holder !== null &&
		holder.pid === owner.pid &&
		holder.start === owner.start &&
		holder.boot === owner.boot
	);
}

export interface LockOptions {
	/** Creating a sandbox runs the project's setup, which has no useful bound. */
	timeoutMs?: number;
	waiting?: (name: string) => void;
}

export async function withLock<T>(
	name: string,
	fn: () => Promise<T>,
	opts: LockOptions = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
	const path = lockPath(name);
	await mkdir(join(dataDir(), "locks"), { recursive: true });

	const owner = await self();
	const deadline = Date.now() + timeoutMs;
	let announced = false;

	while (!(await claim(path, owner))) {
		if (Date.now() > deadline) {
			throw new Error(
				`timed out after ${Math.round(timeoutMs / 1000)}s waiting for another playpen to release ${name}`,
			);
		}
		if (!announced) {
			announced = true;
			opts.waiting?.(name);
		}
		await sleep(150);
	}

	try {
		return await fn();
	} finally {
		// Only if it is still ours: releasing a lock someone else now holds would
		// put a third process into the critical section alongside them.
		if (isMine(await heldBy(path), owner)) {
			await unlink(path).catch(() => {});
		}
	}
}
