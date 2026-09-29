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
 * Copies `$1` into `$2` through `$2/.playpen-staging-<id>`: cleared on every
 * attempt, filled, compared against `$1`, and only then moved into place, by
 * renames within `$2`. So an attempt cut off at any point leaves nothing
 * partial in `$2` that the next attempt would take for newer. `$1` is left as
 * it was.
 *
 * An entry already in `$2` is replaced only by a strictly newer copy, and an
 * identical one is left as it is. No version is ever deleted: the copy that
 * does not end up in place -- the replaced one, or the guest's when it is
 * older, as old but different, or of another type -- is moved to
 * `$2/.playpen-kept/<attempt>/`, and named on stdout as
 * `kept<TAB>path<TAB>where`.
 *
 * Claude Code may be writing to `$2` meanwhile. A target is moved aside before
 * its replacement goes in, so a write through a descriptor opened before lands
 * in the kept copy, and `mv -n` never replaces an entry that appeared since.
 * What remains: 9p has no RENAME_NOREPLACE, so `mv -n` checks and renames in
 * two steps, and an entry created in that instant is replaced.
 *
 * Under a lock on the guest's own disk for the whole run: killing
 * `limactl shell` on the host does not stop the script in the guest, so an
 * interrupted start's move can still be running when the next start's begins,
 * and both work through the same staging path. The stage is this VM's own,
 * named after an id kept on its disk, since two VMs can share one host
 * directory (the same project under two `$LIMA_HOME`s, whose Lima hostnames
 * are the same `lima-<instance>`), and each clears only its own.
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
	'	exec 9>"$HOME/.playpen-history.lock"',
	"	if ! flock -w 600 9; then",
	'		echo "an earlier move of Claude history is still running in the guest" >&2',
	"		exit 1",
	"	fi",
	'	id="$HOME/.playpen-vm-id"',
	'	[ -s "$id" ] || cat /proc/sys/kernel/random/uuid > "$id"',
	'	stage="$dst/.playpen-staging-$(cat "$id")"',
	'	rm -rf "$stage"',
	'	mkdir "$stage"',
	'	tar -C "$src" -cf - . | tar -C "$stage" -xf -',
	'	diff -r --no-dereference "$src" "$stage" >&2',
	"	same() {",
	'		if [ -L "$1" ] || [ -L "$2" ]; then',
	'			[ -L "$1" ] && [ -L "$2" ] && [ "$(readlink "$1")" = "$(readlink "$2")" ]',
	"		else",
	'			cmp -s "$1" "$2"',
	"		fi",
	"	}",
	'	attempt="$(date -u +%Y%m%dT%H%M%SZ)-$$"',
	'	kept="$(cd "$dst" && pwd)/.playpen-kept/$attempt"',
	"	set_aside() {",
	'		mkdir -p "$(dirname "$kept/$2")"',
	'		mv -T "$1" "$kept/$2"',
	'		printf \'kept\\t%s\\t%s\\n\' "$2" ".playpen-kept/$attempt/$2"',
	"	}",
	"	put() {",
	'		mv -nT "$1" "$2" || true',
	'		if [ -e "$1" ] || [ -L "$1" ]; then',
	'			set_aside "$1" "$3"',
	"		fi",
	"	}",
	"	place() (",
	'		cd "$1"',
	"		for name in *; do",
	'			target="$2/$name"',
	'			if [ -d "./$name" ] && [ ! -L "./$name" ] && [ -d "$target" ] && [ ! -L "$target" ]; then',
	'				place "./$name" "$target" "$3$name/"',
	'			elif [ ! -e "$target" ] && [ ! -L "$target" ]; then',
	'				put "./$name" "$target" "$3$name"',
	'			elif [ -d "$target" ] || [ -d "./$name" ]; then',
	'				set_aside "./$name" "$3$name"',
	'			elif same "./$name" "$target"; then',
	"				:",
	'			elif [ -n "$(find "./$name" -maxdepth 0 -newer "$target")" ]; then',
	'				set_aside "$target" "$3$name"',
	'				put "./$name" "$target" "$3$name"',
	"			else",
	'				set_aside "./$name" "$3$name"',
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
 * Claude Code in a guest without the mount writes history to the guest's own
 * disk again, so the marker saying none is there has to go.
 */
const NOT_MOUNTED = 3;

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
 *
 * Each step asked for prints its own result, `takeover<TAB>code` and
 * `import<TAB>code`, and the script goes on to the next: an old archive
 * written short must not keep the guest's own history from counting as moved.
 * The script's exit code is for what stops both, and `NOT_MOUNTED` when the
 * history mount is missing.
 */
export const SETTLE = [
	"set -euo pipefail",
	"umask 077",
	'claude="$HOME/.claude"',
	'[ -O "$claude" ] || sudo chown "$(id -u):$(id -g)" "$claude"',
	'if ! mountpoint -q "$claude/projects"; then',
	'  echo "$claude/projects is not mounted from the host" >&2',
	`  exit ${NOT_MOUNTED}`,
	"fi",
	MOVE_HISTORY,
	IMPORT_HISTORY,
	'if [ "$1" = takeover ]; then',
	'  under="$(mktemp -d)"',
	'  sudo mount --bind "$claude" "$under"',
	'  trap \'sudo umount "$under"; rmdir "$under"\' EXIT',
	"  code=0",
	'  if [ -d "$under/projects" ]; then',
	"    set +e",
	'    move_history "$under/projects" "$claude/projects"',
	"    code=$?",
	"    set -e",
	"  fi",
	"  printf 'takeover\\t%s\\n' \"$code\"",
	"fi",
	'if [ "$2" = archive ]; then',
	"  set +e",
	'  import_history "$claude/projects"',
	"  code=$?",
	"  set -e",
	"  printf 'import\\t%s\\n' \"$code\"",
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

	let result: Awaited<ReturnType<typeof lima.runScript>>;
	try {
		result = await lima.runScript(instance, SETTLE, {
			args: [takeover ? "takeover" : "", archive === null ? "" : "archive"],
			...(archive === null ? {} : { input: archive }),
		});
	} catch (err) {
		warnUnsettled(sandbox, takeover, archive !== null, errorText(err));
		return;
	}
	const why = result.stderr.trim() || `exit ${result.code}`;
	if (result.code === NOT_MOUNTED)
		await unlink(marker(instance)).catch(() => {});
	if (result.code !== 0) {
		warnUnsettled(sandbox, takeover, archive !== null, why);
		return;
	}
	const report = parseReport(result.stdout.toString("utf8"));
	if (report.kept.length > 0) {
		console.error(
			`kept both copies of these; the one not in place is under ${hostDir(sandbox)}:`,
		);
		for (const { path, aside } of report.kept)
			console.error(`  ${path}  (the other: ${aside})`);
	}
	if (takeover) {
		if (report.takeover === 0) await recordOnHost(instance);
		else warnUnsettled(sandbox, true, false, why);
	}
	if (archive === null) return;
	if (report.import !== 0) {
		warnUnsettled(sandbox, false, true, why);
		return;
	}
	try {
		const kept = await setAside(sandbox);
		console.error(`imported Claude history; the archive is kept as ${kept}`);
	} catch (err) {
		// Importing it again is harmless: nothing older replaces anything newer.
		console.error(
			`warning: imported Claude history, but could not rename ${archivePath(sandbox)} (${errorText(err)})`,
		);
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface Report {
	takeover: number | null;
	import: number | null;
	kept: { path: string; aside: string }[];
}

/** What `SETTLE` printed; a step it never reached reads as null. */
function parseReport(stdout: string): Report {
	const report: Report = { takeover: null, import: null, kept: [] };
	for (const line of stdout.split("\n")) {
		const [key, value, aside] = line.split("\t");
		if (value === undefined) continue;
		if (key === "kept") report.kept.push({ path: value, aside: aside ?? "" });
		if (key === "takeover" || key === "import") report[key] = Number(value);
	}
	return report;
}

function warnUnsettled(
	sandbox: string,
	takeover: boolean,
	archive: boolean,
	why: string,
): void {
	console.error(`warning: Claude history is not all on the host (${why})`);
	if (takeover)
		console.error(
			`  what the VM holds stays on its disk; the next start tries again`,
		);
	if (archive)
		console.error(
			`  ${archivePath(sandbox)} is left to import on the next start`,
		);
}

async function recordOnHost(instance: string): Promise<void> {
	await writeFile(marker(instance), "").catch((err: unknown) =>
		console.error(
			`warning: moved Claude history to the host, but could not record it (${errorText(err)}); the next start moves it again`,
		),
	);
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
