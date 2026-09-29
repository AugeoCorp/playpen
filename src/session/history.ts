import {
	chmod,
	link,
	lstat,
	mkdir,
	readFile,
	unlink,
	writeFile,
} from "node:fs/promises";
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
 * makes it 0755 (`os.MkdirAll` in its qemu driver). An existing one is
 * brought back to 0700 too, and refused if it is a link or someone else's:
 * Lima would serve wherever it leads.
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
 * Copies `$1` into `$2` through `$2/.playpen-staging`: cleared on every
 * attempt, filled, compared against `$1`, and only then moved into place, by
 * renames within `$2`. So an attempt cut off at any point leaves nothing
 * partial in `$2` that the next attempt would take for newer. An entry already
 * in `$2` and newer than the copy is kept, and named on stdout; so is one
 * whose type differs, rather than a directory being replaced by a file. `$1`
 * is left as it was.
 *
 * Never call it as a condition (`if`, `||`): bash ignores `set -e` for the
 * whole of a function run that way, even inside it.
 */
export const MOVE_HISTORY = [
	"move_history() (",
	"	set -euo pipefail",
	"	shopt -s nullglob dotglob",
	'	src="$1"',
	'	dst="$2"',
	'	stage="$dst/.playpen-staging"',
	'	rm -rf "$stage"',
	'	mkdir "$stage"',
	'	tar -C "$src" -cf - . | tar -C "$stage" -xf -',
	'	diff -r --no-dereference "$src" "$stage" >&2',
	"	place() (",
	'		cd "$1"',
	"		for name in *; do",
	'			target="$2/$name"',
	'			if [ -d "./$name" ] && [ ! -L "./$name" ] && [ -d "$target" ] && [ ! -L "$target" ]; then',
	'				place "./$name" "$target" "$3$name/"',
	'			elif [ ! -e "$target" ] && [ ! -L "$target" ]; then',
	'				mv -T "./$name" "$target"',
	'			elif [ -n "$(find "$target" -maxdepth 0 -newer "./$name")" ] || [ -d "$target" ] || [ -d "./$name" ]; then',
	'				echo "$3$name"',
	"			else",
	'				mv -fT "./$name" "$target"',
	"			fi",
	"		done",
	"	)",
	'	place "$stage" "$(cd "$dst" && pwd)" ""',
	'	rm -rf "$stage"',
	")",
].join("\n");

/**
 * The archive-on-destroy scheme's tar on stdin, into `$1`. Unpacked on the
 * guest's own disk first, where tar reports a truncated archive, then moved
 * like the guest's own history.
 */
export const IMPORT_HISTORY = [
	"import_history() (",
	"	set -euo pipefail",
	'	unpacked="$(mktemp -d "$HOME/.playpen-import.XXXXXX")"',
	"	trap 'rm -rf \"$unpacked\"' EXIT",
	'	tar -C "$unpacked" -xf -',
	`	move_history "$unpacked/${GUEST_REL}" "$1"`,
	")",
].join("\n");

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
 * underneath. That copy stays there, and goes with the disk. `$2` is `archive`
 * when the old archive is on stdin.
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
	MOVE_HISTORY,
	IMPORT_HISTORY,
	'if [ "$1" = takeover ]; then',
	'  under="$(mktemp -d)"',
	'  sudo mount --bind "$claude" "$under"',
	'  trap \'sudo umount "$under"; rmdir "$under"\' EXIT',
	'  if [ -d "$under/projects" ]; then',
	'    move_history "$under/projects" "$claude/projects"',
	"  fi",
	"fi",
	'if [ "$2" = archive ]; then',
	'  import_history "$claude/projects"',
	"fi",
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
	let kept = "";
	try {
		const result = await lima.runScript(instance, SETTLE, {
			args: [takeover ? "takeover" : "", archive === null ? "" : "archive"],
			...(archive === null ? {} : { input: archive }),
		});
		failure =
			result.code === 0 ? null : result.stderr.trim() || `exit ${result.code}`;
		kept = result.stdout.toString("utf8").trim();
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
	if (kept !== "") {
		console.error(`kept the newer copies already in ${hostDir(sandbox)} of:`);
		for (const path of kept.split("\n")) console.error(`  ${path}`);
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
