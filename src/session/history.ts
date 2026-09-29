import { mkdir, readFile, writeFile } from "node:fs/promises";
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
 */
const GUEST_REL = ".claude/projects";

/**
 * Where Lima mounts the host's history directory. Lima expands `{{.Home}}` to
 * the guest user's home when it loads the instance (`executeGuestTemplate` in
 * its limayaml package), so the guest's user name and home layout -- which
 * Lima derives from the host user and has changed between releases -- are
 * never worked out here.
 */
export const GUEST_MOUNT_POINT = `{{.Home}}/${GUEST_REL}`;

/**
 * The guest writes here freely, symlinks included, so nothing on the host
 * reads what is inside: only Lima's mount and the guest touch it.
 */
export function hostDir(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(historyDir(), sandbox);
}

/**
 * Before every boot, since Lima creates a missing mount location itself, and
 * makes it 0755 (`os.MkdirAll` in its qemu driver).
 */
export async function makeHostDir(sandbox: string): Promise<string> {
	const dir = hostDir(sandbox);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/**
 * Once per boot. cloud-init creates a mount point's missing parents as root
 * (`util.ensure_dir` in its cc_mounts module), so on a fresh clone the guest
 * user would not own `~/.claude`, and Claude Code could write nothing but
 * history.
 */
const SETTLE = [
	"set -euo pipefail",
	'claude="$HOME/.claude"',
	'[ -O "$claude" ] || sudo chown "$(id -u):$(id -g)" "$claude"',
	'if ! mountpoint -q "$claude/projects"; then',
	'  echo "$claude/projects is not mounted from the host" >&2',
	"  exit 1",
	"fi",
].join("\n");

/** Never throws: a sandbox whose history is not settled still runs. */
export async function settle(instance: string): Promise<void> {
	let failure: string | null;
	try {
		const result = await lima.runScript(instance, SETTLE);
		failure =
			result.code === 0 ? null : result.stderr.trim() || `exit ${result.code}`;
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
	if (failure !== null) {
		console.error(`warning: Claude history is not on the host (${failure})`);
	}
}

/** Joined into a path that is written and read, so it is checked like `store`'s. */
export function archivePath(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(historyDir(), `${sandbox}.tar`);
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
		await mkdir(historyDir(), { recursive: true });
		await writeFile(archivePath(sandbox), result.stdout);
	} catch (err) {
		console.error(
			`warning: could not save Claude history (${err instanceof Error ? err.message : err})`,
		);
	}
}

/** Kept after restoring, so it stays the last known history if this one is lost. */
export async function restore(
	instance: string,
	sandbox: string,
): Promise<boolean> {
	let tar: Buffer;
	try {
		tar = await readFile(archivePath(sandbox));
	} catch {
		return false;
	}

	const script = ["set -eu", "umask 077", 'cd "$HOME"', "tar -xf -"].join("\n");
	const result = await lima.runScript(instance, script, { input: tar });
	if (result.code !== 0) {
		console.error(
			`warning: could not restore Claude history (${result.stderr.trim()})`,
		);
		return false;
	}
	return true;
}
