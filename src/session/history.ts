import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { historyDir } from "../config.ts";
import * as lima from "../lima/client.ts";
import { assertSandboxName } from "./identity.ts";

/**
 * Claude Code keeps session transcripts and the persistent memory directory
 * under `~/.claude/projects` in the guest. That whole directory is a host
 * directory mounted writable, so history is on the host as it is written and
 * outlives the VM: rebuild, remove, a crash.
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
 * Called before every boot: Lima creates a missing mount location itself, 0755
 * (`os.MkdirAll` in its qemu driver), and serves wherever a link leads.
 */
export async function makeHostDir(sandbox: string): Promise<string> {
	const dir = hostDir(sandbox);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const info = await lstat(dir);
	if (!info.isDirectory())
		throw new Error(`${dir} is not a directory; move it aside and start again`);
	if (info.uid !== process.getuid?.())
		throw new Error(`${dir} is owned by uid ${info.uid}, not by you`);
	await chmod(dir, 0o700);
	return dir;
}

/**
 * cloud-init creates a mount point's missing parents as root (`util.ensure_dir`
 * in its cc_mounts module), so on a fresh clone the guest user would not own
 * `~/.claude`, and Claude Code could write nothing there but history.
 */
export const PREPARE_GUEST = [
	"set -eu",
	'claude="$HOME/.claude"',
	'if ! mountpoint -q "$claude/projects"; then',
	'  echo "$claude/projects is not mounted from the host" >&2',
	"  exit 1",
	"fi",
	'sudo chown "$(id -u):$(id -g)" "$claude"',
].join("\n");

export async function prepareGuest(instance: string): Promise<void> {
	const why = await lima.runScript(instance, PREPARE_GUEST).then(
		(result) =>
			result.code === 0 ? null : result.stderr.trim() || `exit ${result.code}`,
		(err: unknown) => (err instanceof Error ? err.message : String(err)),
	);
	if (why !== null)
		console.error(`warning: the guest's ~/.claude is not ready (${why})`);
}
