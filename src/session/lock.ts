import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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

/** Breaks a lock whose holder died; returns false while a live one holds it. */
async function claim(path: string, owner: Owner): Promise<boolean> {
	try {
		await writeFile(path, `${JSON.stringify(owner)}\n`, {
			encoding: "utf8",
			// O_CREAT|O_EXCL: exactly one process wins the create.
			flag: "wx",
		});
		return true;
	} catch {
		let holder: Owner;
		try {
			holder = JSON.parse(await readFile(path, "utf8")) as Owner;
		} catch {
			// Unreadable or gone; either way it is not a lock anyone is holding.
			await unlink(path).catch(() => {});
			return false;
		}
		if (!(await isLive(holder))) await unlink(path).catch(() => {});
		return false;
	}
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
		await unlink(path).catch(() => {});
	}
}
