import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { historyDir, limaHome } from "../config.ts";
import { exists } from "../fs.ts";
import * as lima from "../lima/client.ts";
import { assertSandboxName } from "./identity.ts";

/**
 * Claude Code keeps session transcripts and the persistent memory directory
 * under `~/.claude/projects` in the guest. That whole directory is a host
 * directory mounted writable, so history is on the host as it is written and
 * outlives the VM: rebuild, remove, a crash. There is no second copy to sync.
 *
 * The whole directory rather than one project's slug: a sandbox serves a
 * single project, so that is already the scope, and it avoids depending on
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
 * In the instance directory, so it lives exactly as long as the disk it
 * vouches for: removing or recloning the instance deletes both, and the guest
 * cannot reach it.
 */
function marker(instance: string): string {
	return join(limaHome(), instance, "playpen-history-on-host");
}

/**
 * True once a start has moved whatever history this instance's disk held to
 * the host and checked it there. Until then, deleting the VM may delete
 * history, however its lima.yaml looks.
 */
export function onHost(instance: string): Promise<boolean> {
	return exists(marker(instance));
}

/**
 * Once per boot, on every start until the history is on the host, and on a
 * start that finds an archive left by the older archive-on-destroy scheme.
 *
 * cloud-init creates a mount point's missing parents as root (`util.ensure_dir`
 * in its cc_mounts module), so on a fresh clone the guest user would not own
 * `~/.claude`, and Claude Code could write nothing there but history.
 *
 * `$1` is `takeover` until the history is on the host: a sandbox that kept its
 * history in the guest before the mount existed still has it, hidden under the
 * mount. A bind without `--rbind` leaves submounts out, so it shows what is
 * underneath. `$2` is `archive` when the old archive is on stdin.
 *
 * `--keep-newer-files` so an older copy never overwrites a newer one. GNU tar
 * 1.35 exits 2 with it alone on every directory that already exists;
 * `--keep-directory-symlink` takes it through that path cleanly, and leaves
 * the existing directories' modes alone, the host directory's 0700 included.
 */
const SETTLE = [
	"set -euo pipefail",
	"umask 077",
	'claude="$HOME/.claude"',
	'[ -O "$claude" ] || sudo chown "$(id -u):$(id -g)" "$claude"',
	'if ! mountpoint -q "$claude/projects"; then',
	'  echo "$claude/projects is not mounted from the host" >&2',
	"  exit 1",
	"fi",
	'merge() { tar --keep-newer-files --keep-directory-symlink -xf - "$@"; }',
	'if [ "$1" = takeover ]; then',
	'  under="$(mktemp -d)"',
	'  sudo mount --bind "$claude" "$under"',
	'  trap \'sudo umount "$under"; rmdir "$under"\' EXIT',
	'  if [ -n "$(ls -A "$under/projects" 2>/dev/null)" ]; then',
	'    tar -C "$under" -cf - projects | merge -C "$claude"',
	'    find "$under/projects" -mindepth 1 -delete',
	"  fi",
	"fi",
	`if [ "$2" = archive ]; then merge -C "$HOME" ${GUEST_REL}; fi`,
].join("\n");

/**
 * Never throws: a sandbox whose history could not be settled still runs.
 *
 * The archive travels as bytes and is unpacked in the guest; the host never
 * reads it as a tar. It is renamed only once the guest has taken it, and never
 * deleted.
 */
export async function settle(
	instance: string,
	sandbox: string,
	booted: boolean,
): Promise<void> {
	const archive = await readFile(archivePath(sandbox)).catch(() => null);
	const takeover = !(await onHost(instance));
	if (!booted && !takeover && archive === null) return;

	let failure: string | null;
	try {
		const result = await lima.runScript(instance, SETTLE, {
			args: [takeover ? "takeover" : "", archive === null ? "" : "archive"],
			...(archive === null ? {} : { input: archive }),
		});
		failure =
			result.code === 0 ? null : result.stderr.trim() || `exit ${result.code}`;
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}

	if (failure !== null) {
		console.error(`warning: Claude history is not on the host (${failure})`);
		if (takeover)
			console.error(
				`  what the VM holds stays on its disk; the next start tries again`,
			);
		if (archive !== null)
			console.error(
				`  ${archivePath(sandbox)} is left to import on the next start`,
			);
		return;
	}
	if (takeover)
		await writeFile(marker(instance), "").catch((err: unknown) =>
			console.error(
				`warning: moved Claude history to the host, but could not record it (${err instanceof Error ? err.message : err}); the next start moves it again`,
			),
		);
	if (archive === null) return;
	try {
		const kept = await setAside(sandbox);
		console.error(`imported Claude history; the archive is kept as ${kept}`);
	} catch (err) {
		// Importing it again is harmless: nothing older replaces anything newer.
		console.error(
			`warning: imported Claude history, but could not rename ${archivePath(sandbox)} (${err instanceof Error ? err.message : err})`,
		);
	}
}

/** Linked, not renamed, so an archive imported before is never overwritten. */
async function setAside(sandbox: string): Promise<string> {
	const from = archivePath(sandbox);
	let to = join(historyDir(), `${sandbox}.imported.tar`);
	try {
		await link(from, to);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		to = join(historyDir(), `${sandbox}.imported-${Date.now()}.tar`);
		await link(from, to);
	}
	await unlink(from);
	return to;
}

/**
 * Where the archive-on-destroy scheme this replaced left a sandbox's history.
 * Joined into a path that is read and renamed, so it is checked like `store`'s.
 */
export function archivePath(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(historyDir(), `${sandbox}.tar`);
}
