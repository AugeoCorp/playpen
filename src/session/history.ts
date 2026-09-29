import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { historyDir } from "../config.ts";
import * as lima from "../lima/client.ts";
import { assertSandboxName } from "./identity.ts";

/**
 * Claude Code keeps session transcripts and the persistent memory directory in
 * the guest, and nothing syncs them back to the host, so recloning a sandbox
 * would drop both. They are archived out before a sandbox is destroyed and
 * restored into its replacement.
 *
 * The whole directory travels rather than one project's slug: a sandbox serves
 * a single project, so that is already the scope, and it avoids depending on
 * how Claude Code names these directories.
 *
 * An archive stays pending on the host until a restore of it succeeds, and no
 * archive ever replaces another: a guest that never got its history back can
 * still be archived, and that archive holds none of what is pending.
 */
const GUEST_REL = ".claude/projects";

/** Joined into paths that are written, read and renamed, so it is checked like `store`'s. */
export function sandboxHistoryDir(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(historyDir(), sandbox);
}

function pendingDir(sandbox: string): string {
	return join(sandboxHistoryDir(sandbox), "pending");
}

/** Named for when it was taken, so the names sort oldest first. */
function archiveName(at: number): string {
	return `${new Date(at).toISOString().replaceAll(":", "")}.tar`;
}

/** `put` must fail with EEXIST rather than replace a file already there. */
async function addPending(
	sandbox: string,
	at: number,
	put: (path: string) => Promise<void>,
): Promise<void> {
	const dir = pendingDir(sandbox);
	await mkdir(dir, { recursive: true });
	for (let stamp = at; ; stamp++) {
		try {
			return await put(join(dir, archiveName(stamp)));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	}
}

/** Never throws: losing history is bad, but blocking a delete over it is worse. */
export async function archive(
	instance: string,
	sandbox: string,
): Promise<void> {
	// Succeeds with no output when there is nothing to archive, rather than
	// signalling it through an exit code limactl may not pass back.
	const script = [
		"set -eu",
		'cd "$HOME"',
		`if [ -d ${GUEST_REL} ]; then exec tar -cf - ${GUEST_REL}; fi`,
	].join("\n");

	try {
		const result = await lima.runScript(instance, script);
		if (result.code === 0 && result.stdout.length === 0) return;
		if (result.code !== 0) {
			console.error(
				`warning: could not save Claude history (${result.stderr.trim() || `exit ${result.code}`})`,
			);
			return;
		}
		await addPending(sandbox, Date.now(), (path) =>
			writeFile(path, result.stdout, { flag: "wx" }),
		);
	} catch (err) {
		console.error(
			`warning: could not save Claude history (${err instanceof Error ? err.message : err})`,
		);
	}
}

/** Unpacks the archive on stdin into the guest's home, readable only by its owner. */
const UNPACK = "cd && umask 077 && tar -xf -";

async function unpack(instance: string, path: string): Promise<string | null> {
	try {
		const result = await lima.runScript(instance, UNPACK, {
			input: await readFile(path),
		});
		return result.code === 0
			? null
			: result.stderr.trim() || `exit ${result.code}`;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/**
 * Runs on every start, so a restore that failed is retried by the next one.
 * With nothing pending it only reads the host's history directory; the guest
 * is sent nothing.
 *
 * A restored archive becomes `restored.tar`, replacing the one before: the
 * guest now holds its contents, so the next archive includes them.
 *
 * Never throws: by now the sandbox is up, and a failure here must not fail the
 * start.
 */
export async function restore(
	instance: string,
	sandbox: string,
): Promise<void> {
	try {
		const dir = pendingDir(sandbox);
		const pending = (await readdir(dir).catch(() => []))
			.filter((name) => name.endsWith(".tar"))
			.sort();
		for (const [done, name] of pending.entries()) {
			const path = join(dir, name);
			const failure = await unpack(instance, path);
			if (failure !== null) {
				warnNotRestored(failure, path, pending.length - done - 1);
				return;
			}
			await rename(path, join(sandboxHistoryDir(sandbox), "restored.tar"));
		}
		if (pending.length > 0) {
			console.error(`restored Claude history from the previous sandbox`);
		}
	} catch (err) {
		console.error(
			`warning: could not restore Claude history (${err instanceof Error ? err.message : err})`,
		);
		console.error(`  the next start of this sandbox tries again.`);
	}
}

function warnNotRestored(failure: string, path: string, later: number): void {
	console.error(`warning: could not restore Claude history (${failure})`);
	console.error(
		`  it is kept in ${path}; the next start of this sandbox tries again.`,
	);
	if (later > 0) {
		console.error(
			`  ${later === 1 ? "1 later archive waits" : `${later} later archives wait`} beside it.`,
		);
	}
}
