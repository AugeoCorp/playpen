import {
	chmod,
	copyFile,
	link,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { historyDir, limaHome } from "../config.ts";
import { exists } from "../fs.ts";
import * as lima from "../lima/client.ts";
import { assertSandboxName } from "./identity.ts";

/**
 * Claude Code keeps session transcripts and the persistent memory directory in
 * the guest, and nothing syncs them back to the host, so recloning a sandbox
 * would drop both. The host keeps one copy per sandbox, saved at every stop and
 * restored at every start into a VM that does not yet hold it.
 *
 * The copy is replaced only by a VM known to hold it: one it was restored
 * into, or one it was saved from. A VM that does not is first given the copy,
 * so what it saves includes it; if that fails, what it saves goes beside the
 * copy instead of over it.
 *
 * The whole directory travels rather than one project's slug: a sandbox serves
 * a single project, so that is already the scope, and it avoids depending on
 * how Claude Code names these directories.
 */
const GUEST_REL = ".claude/projects";

/** A wedged guest must not hold a start or a stop forever; it goes ahead without the history. */
const GUEST_TIMEOUT_MS = 120_000;

/** Joined into a path that is written and read, so it is checked like `store`'s. */
export function archivePath(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(historyDir(), `${sandbox}.tar`);
}

function previousPath(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(historyDir(), `${sandbox}.prev.tar`);
}

/** What a VM saved while it could not be given the copy. */
function unrestoredPath(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(historyDir(), `${sandbox}.unrestored.tar`);
}

/**
 * Present when this VM holds the host copy. In the Lima instance's own
 * directory, so deleting or recloning the instance drops it and a new clone
 * never reads as holding it. On the host because the guest is untrusted: a
 * marker it could write would let it replace the copy.
 */
function holdsCopyMarker(instance: string): string {
	return join(limaHome(), instance, "playpen-holds-history");
}

/**
 * Present while a VM is stopped with its history saved: written when playpen
 * stops it after a save, removed at every start. A stopped VM without it was
 * stopped some other way, by limactl, a host shutdown, or a playpen from before
 * stops saved, and may hold history the host has not got.
 */
function savedMarker(instance: string): string {
	return join(limaHome(), instance, "playpen-history-saved");
}

export async function markSaved(instance: string): Promise<void> {
	await writeFile(savedMarker(instance), "");
}

export async function clearSaved(instance: string): Promise<void> {
	await rm(savedMarker(instance), { force: true });
}

export function wasSaved(instance: string): Promise<boolean> {
	return exists(savedMarker(instance));
}

/**
 * Transcripts are private. `mkdir`'s own `mode` applies only on creation, so a
 * directory from before this needs the `chmod` too.
 */
async function ensureHistoryDir(): Promise<void> {
	await mkdir(historyDir(), { recursive: true, mode: 0o700 });
	await chmod(historyDir(), 0o700);
}

/** Written beside `path` and renamed over it, so a failure part way leaves the old file whole. */
async function writeBeside(path: string, tar: Buffer): Promise<void> {
	const temp = `${path}.${process.pid}.tmp`;
	await ensureHistoryDir();
	try {
		await writeFile(temp, tar, { mode: 0o600 });
		await rename(temp, path);
	} catch (err) {
		await rm(temp, { force: true });
		throw err;
	}
}

/**
 * A hard link where the filesystem allows one, so keeping it costs nothing; a
 * copy where it does not (EPERM on filesystems without hard links, EXDEV
 * across mounts).
 */
async function keepAs(path: string, kept: string): Promise<void> {
	try {
		await link(path, kept);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return;
		if (code !== "EPERM" && code !== "EXDEV") throw err;
		await copyFile(path, kept);
	}
}

/** The old copy becomes `<sandbox>.prev.tar`. */
async function replaceCopy(sandbox: string, tar: Buffer): Promise<void> {
	const path = archivePath(sandbox);
	const previous = previousPath(sandbox);
	await rm(previous, { force: true });
	await keepAs(path, previous);
	await writeBeside(path, tar);
}

/**
 * Whether the guest's history now includes what the copy holds. True with no
 * copy to hold. Otherwise unpacks the copy into the guest once, and marks the
 * VM as holding it.
 */
async function ensureHeld(instance: string, sandbox: string): Promise<boolean> {
	const path = archivePath(sandbox);
	const marker = holdsCopyMarker(instance);
	if ((await exists(marker)) || !(await exists(path))) return true;
	let failure: string;
	try {
		const result = await lima.runScript(instance, UNPACK, {
			input: await readFile(path),
			timeoutMs: GUEST_TIMEOUT_MS,
		});
		if (result.code === 0) {
			await writeFile(marker, "");
			console.error(`restored Claude history from ${path}`);
			return true;
		}
		failure = result.stderr.trim() || `exit ${result.code}`;
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
	console.error(`warning: could not restore Claude history (${failure})`);
	return false;
}

/**
 * True once the guest's history is on the host, or when it has none. Never
 * throws: losing history is bad, but blocking a stop or a delete over it is
 * worse.
 */
export async function archive(
	instance: string,
	sandbox: string,
): Promise<boolean> {
	// Succeeds with no output when there is nothing to archive, rather than
	// signalling it through an exit code limactl may not pass back.
	const script = [
		"set -eu",
		'cd "$HOME"',
		`if [ -d ${GUEST_REL} ]; then exec tar -cf - ${GUEST_REL}; fi`,
	].join("\n");

	try {
		const held = await ensureHeld(instance, sandbox);
		const result = await lima.runScript(instance, script, {
			timeoutMs: GUEST_TIMEOUT_MS,
		});
		// GNU tar exits 1 when a file changed while it was read, as a transcript
		// Claude is still writing can; the archive is complete, with that file
		// as it was at some point during the read.
		const changedWhileRead = result.code === 1 && result.stdout.length > 0;
		if (result.code !== 0 && !changedWhileRead) {
			console.error(
				`warning: could not save Claude history (${result.stderr.trim() || `exit ${result.code}`})`,
			);
			return false;
		}
		if (changedWhileRead) console.error(`note: ${result.stderr.trim()}`);
		if (result.stdout.length === 0) return true;
		if (held) {
			await replaceCopy(sandbox, result.stdout);
			await writeFile(holdsCopyMarker(instance), "");
			return true;
		}
		const unrestored = unrestoredPath(sandbox);
		await writeBeside(unrestored, result.stdout);
		console.error(
			`  saved this sandbox's history to ${unrestored} instead, leaving ${archivePath(sandbox)} as it was.`,
		);
		console.error(`  the next start tries the restore again.`);
		return true;
	} catch (err) {
		console.error(
			`warning: could not save Claude history (${err instanceof Error ? err.message : err})`,
		);
		return false;
	}
}

/**
 * Unpacks the archive on stdin into the guest's home, readable only by its
 * owner.
 *
 * `--keep-newer-files` so an archive never replaces a file the guest has
 * written since it was taken, such as a newer MEMORY.md.
 *
 * `--keep-directory-symlink` because without it `--keep-newer-files` fails on
 * every directory that already exists ("Unexpected inconsistency when making
 * directory", exit 2): `extract_dir` in GNU tar's src/extract.c accepts an
 * existing directory only under that option or one of the other old-files
 * modes. Seen on GNU tar 1.35, the guest's.
 */
export const UNPACK =
	"cd && umask 077 && tar --keep-newer-files --keep-directory-symlink -xf -";

/**
 * Runs on every start. Once this VM holds the copy it sends the guest nothing,
 * so transcripts deleted in the guest stay deleted; until then each start
 * tries again.
 *
 * Never throws: by now the sandbox is up, and a failure here must not fail the
 * start.
 */
export async function restore(
	instance: string,
	sandbox: string,
): Promise<void> {
	if (await ensureHeld(instance, sandbox)) return;
	console.error(
		`  it stays in ${archivePath(sandbox)}, and the next start of this sandbox tries again.`,
	);
}
