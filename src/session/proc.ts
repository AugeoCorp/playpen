import { readFile } from "node:fs/promises";

/**
 * Enough to tell whether a process recorded earlier is still the same one.
 *
 * A PID alone is not: the kernel recycles them, and a recycled PID would keep a
 * sandbox alive forever or block a delete. `start` is the process's own start
 * time, so a reused number does not match; `boot` distinguishes two boots whose
 * tick counters happen to agree.
 */
export interface Owner {
	pid: number;
	start: string;
	boot: string;
}

/** Linux only, like the rest of playpen: /proc is where this lives. */
async function bootId(): Promise<string> {
	return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}

/**
 * Field 22 of /proc/<pid>/stat, in clock ticks since boot. Fields are space
 * separated, but field 2 is the executable name in parentheses and may itself
 * contain spaces and parentheses -- so the split starts after the last `)`,
 * which puts field 3 at index 0.
 */
async function startTime(pid: number): Promise<string | null> {
	let stat: string;
	try {
		stat = await readFile(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return rest[19] ?? null;
}

/** The identity a live process has right now, or null if it is not running. */
export async function owner(pid: number): Promise<Owner | null> {
	const start = await startTime(pid);
	if (start === null) return null;
	return { pid, start, boot: await bootId() };
}

export async function self(): Promise<Owner> {
	const me = await owner(process.pid);
	if (me === null) throw new Error(`cannot read /proc/${process.pid}/stat`);
	return me;
}

export async function isLive(owner: Owner): Promise<boolean> {
	if (owner.boot !== (await bootId())) return false;
	return (await startTime(owner.pid)) === owner.start;
}
