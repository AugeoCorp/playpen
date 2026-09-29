import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
 * into, or one it was saved from. A VM whose restore failed would otherwise
 * replace it with history that never included it.
 *
 * The whole directory travels rather than one project's slug: a sandbox serves
 * a single project, so that is already the scope, and it avoids depending on
 * how Claude Code names these directories.
 */
const GUEST_REL = ".claude/projects";

/** Joined into a path that is written and read, so it is checked like `store`'s. */
export function archivePath(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(historyDir(), `${sandbox}.tar`);
}

function previousPath(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(historyDir(), `${sandbox}.prev.tar`);
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
 * Written beside the copy and renamed over it, so a failure part way leaves
 * the old copy whole. The old one becomes `<sandbox>.prev.tar`.
 */
async function replaceCopy(sandbox: string, tar: Buffer): Promise<void> {
	const path = archivePath(sandbox);
	const previous = previousPath(sandbox);
	const temp = `${path}.${process.pid}.tmp`;
	await mkdir(historyDir(), { recursive: true });
	await writeFile(temp, tar);
	await rm(previous, { force: true });
	await link(path, previous).catch((err: NodeJS.ErrnoException) => {
		if (err.code !== "ENOENT") throw err;
	});
	await rename(temp, path);
}

/** Never throws: losing history is bad, but blocking a stop or a delete over it is worse. */
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
		const path = archivePath(sandbox);
		const marker = holdsCopyMarker(instance);
		if ((await exists(path)) && !(await exists(marker))) {
			console.error(
				`warning: Claude history not saved: ${path} has not been restored into this sandbox yet,`,
			);
			console.error(
				`  and saving would replace it. the next start restores it.`,
			);
			return;
		}
		const result = await lima.runScript(instance, script);
		if (result.code === 0 && result.stdout.length === 0) return;
		if (result.code !== 0) {
			console.error(
				`warning: could not save Claude history (${result.stderr.trim() || `exit ${result.code}`})`,
			);
			return;
		}
		await replaceCopy(sandbox, result.stdout);
		await writeFile(marker, "");
	} catch (err) {
		console.error(
			`warning: could not save Claude history (${err instanceof Error ? err.message : err})`,
		);
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
	const path = archivePath(sandbox);
	const marker = holdsCopyMarker(instance);
	let failure: string;
	try {
		if ((await exists(marker)) || !(await exists(path))) return;
		const result = await lima.runScript(instance, UNPACK, {
			input: await readFile(path),
		});
		if (result.code === 0) {
			await writeFile(marker, "");
			console.error(`restored Claude history from ${path}`);
			return;
		}
		failure = result.stderr.trim() || `exit ${result.code}`;
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
	console.error(`warning: could not restore Claude history (${failure})`);
	console.error(
		`  it stays in ${path}, and the next start of this sandbox tries again.`,
	);
	console.error(`  until then, stopping this sandbox does not save over it.`);
}
