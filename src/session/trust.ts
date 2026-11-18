import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { trustDir } from "../config.ts";
import { confirm } from "../prompt.ts";
import {
	type ConfigGraph,
	type GraphFile,
	readConfigGraph,
	sha256,
} from "./configgraph.ts";
import { assertSandboxName } from "./identity.ts";
import { markChanges } from "./linediff.ts";
import {
	type ConfigResult,
	findConfigFile,
	hasLegacyIgnore,
	importConfig,
} from "./projectconfig.ts";

export type TrustState =
	/** No config file in the project. Nothing to decide. */
	| "absent"
	/** The graph matches what you approved. Import it without asking. */
	| "trusted"
	/** Never seen before. First use of this config for this sandbox. */
	| "unpinned"
	/** Seen before, and something in the graph has changed since you approved it. */
	| "changed";

/** Pure, because this is the line that decides whether project code runs on the host. */
export function decideTrust(
	pinned: string | null,
	current: string | null,
): TrustState {
	if (current === null) return "absent";
	if (pinned === null) return "unpinned";
	return pinned === current ? "trusted" : "changed";
}

const trustRecord = z.object({
	/** Hash of the whole approved graph. */
	hash: z.string(),
	/** Which of CONFIG_FILES was approved, so a rename is not silently inherited. */
	file: z.string(),
	/** Per-file hashes, so a re-prompt can say which files moved. */
	files: z.record(z.string(), z.string()),
	approved: z.string(),
});

type TrustRecord = z.infer<typeof trustRecord>;

function recordPath(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(trustDir(), `${sandbox}.json`);
}

function snapshotDir(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(trustDir(), sandbox);
}

async function readRecord(sandbox: string): Promise<TrustRecord | null> {
	try {
		return trustRecord.parse(
			JSON.parse(await readFile(recordPath(sandbox), "utf8")),
		);
	} catch {
		return null;
	}
}

export async function pinConfig(
	sandbox: string,
	graph: ConfigGraph,
): Promise<void> {
	await mkdir(trustDir(), { recursive: true });
	const files: Record<string, string> = {};
	for (const f of graph.files) files[f.rel] = f.hash;
	const record: TrustRecord = {
		hash: graph.hash,
		file: graph.entry,
		files,
		approved: new Date().toISOString(),
	};
	await writeFile(
		recordPath(sandbox),
		`${JSON.stringify(record, null, 2)}\n`,
		"utf8",
	);
}

/**
 * Write the graph's bytes outside the project and return the entry path.
 *
 * What gets imported is this copy, not the project file: between hashing and
 * importing, a running guest can rewrite anything under the mount. The
 * snapshot is exactly the bytes that were hashed, so the code that runs is the
 * code that was approved.
 */
async function snapshot(sandbox: string, graph: ConfigGraph): Promise<string> {
	const dir = snapshotDir(sandbox);
	await rm(dir, { recursive: true, force: true });
	for (const f of graph.files) {
		const path = join(dir, f.rel);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, f.contents, "utf8");
	}
	return join(dir, graph.entry);
}

/**
 * What a terminal acts on or draws as nothing: controls other than tab, format
 * characters such as bidi overrides, the line separators, lone surrogates and
 * default-ignorable code points. Several are legal in a JavaScript name, so
 * `false` followed by one is a name and not the keyword.
 */
const UNSHOWABLE =
	/(?!\t)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;

export function escapeUnshowable(text: string): string {
	return text.replace(
		UNSHOWABLE,
		(character) => `\\u{${character.codePointAt(0)?.toString(16)}}`,
	);
}

const ESCAPES_WARNING =
	"  warning: invisible or control characters are shown above as escapes like \\u{1b}";

/** Names and contents come from a directory the guest can write. */
async function preview(
	sandbox: string,
	graph: ConfigGraph,
	approved: Record<string, string> | undefined,
): Promise<string> {
	const sections = await Promise.all(
		graph.files.map(async (file) => {
			const approvedHash = approved?.[file.rel];
			const marked =
				approvedHash === file.hash
					? []
					: await markedLines(sandbox, file, approvedHash);
			const status =
				approvedHash === undefined
					? "new"
					: marked.length === 0
						? "unchanged"
						: marked.some((line) => !line.startsWith(" "))
							? "changed"
							: "changed only in line endings";
			return [
				`  ── ${file.rel} (${status})`,
				...marked.map((line) => `  │ ${line}`),
			];
		}),
	);
	const lines = sections.flat();
	const shown = lines.map(escapeUnshowable);
	return (
		shown.some((line, index) => line !== lines[index])
			? [...shown, "", ESCAPES_WARNING]
			: shown
	).join("\n");
}

/**
 * Every line of the file as it was hashed, never as it is on disk now, marked
 * against the approved copy. Unchanged lines are shown too: an edit can change
 * what a line far from it does, such as closing a template literal that held
 * it. The approved copy is in `trust/`, which no guest mounts. Without one
 * that matches its approved hash every line is `+`, so a line that starts with
 * `-` cannot pass for a removed one.
 */
async function markedLines(
	sandbox: string,
	file: GraphFile,
	approvedHash: string | undefined,
): Promise<string[]> {
	const approved = await readFile(
		join(snapshotDir(sandbox), file.rel),
		"utf8",
	).catch(() => undefined);
	return markChanges(
		approved !== undefined && sha256(approved) === approvedHash
			? linesOf(approved)
			: [],
		linesOf(file.contents),
	);
}

/**
 * Escaping a line terminator does not stop it ending a line for the parser, so
 * a line also ends on screen wherever JavaScript ends one (ECMA-262,
 * LineTerminator). A lone `\r`, U+2028 or U+2029 stays on the line it ends, to
 * be escaped there.
 */
function linesOf(contents: string): string[] {
	return contents
		.split(/(?<=\n|\r(?!\n)|\u2028|\u2029)/)
		.map((line) => line.replace(/\r?\n$/, ""));
}

export interface TrustedConfig extends ConfigResult {
	state: TrustState;
	/** False when a config exists but was not executed, so masks are missing. */
	loaded: boolean;
}

/**
 * Load the project config, but only after its import graph has been approved.
 *
 * Fails closed in both directions that matter: without a TTY there is nobody to
 * ask, so the config is not executed; and declining leaves the sandbox unmasked
 * rather than aborting, because masks are a performance feature and losing them
 * is a degraded run, not a broken one.
 */
export async function loadTrustedConfig(
	projectDir: string,
	sandbox: string,
): Promise<TrustedConfig> {
	const legacyIgnore = await hasLegacyIgnore(projectDir);
	const name = await findConfigFile(projectDir);
	const skipped = (state: TrustState, error?: string): TrustedConfig => ({
		masked: [],
		mounts: [],
		setup: [],
		network: { allow: [], mode: "enforce", ports: [], secrets: [] },
		rejected: [],
		rejectedMounts: [],
		rejectedSetup: [],
		rejectedNetwork: [],
		legacyIgnore,
		state,
		loaded: false,
		...(error === undefined ? {} : { error }),
	});

	if (name === null) return skipped("absent");

	let graph: ConfigGraph;
	try {
		graph = await readConfigGraph(projectDir, name);
	} catch (err) {
		return skipped(
			"unpinned",
			err instanceof Error ? err.message : String(err),
		);
	}

	const record = await readRecord(sandbox);
	const pinned = record?.file === name ? record.hash : null;
	const state = decideTrust(pinned, graph.hash);

	if (state !== "trusted") {
		if (!process.stdin.isTTY) {
			console.error(
				`warning: ${name} is ${state === "changed" ? "changed since you approved it" : "not yet approved"}, and there is no terminal to ask.`,
			);
			console.error(`  not executing it; this sandbox will run unmasked.`);
			console.error(`  approve it with an interactive: playpen start`);
			return skipped(state);
		}

		const count = graph.files.length;
		console.error("");
		console.error(
			state === "changed"
				? `${name} has changed since you approved it.`
				: `${name} has not been approved for this sandbox yet.`,
		);
		console.error(
			`  playpen imports this file on the host, so it runs as you.`,
		);
		console.error(
			`  a process inside the sandbox can write it — read it before approving.`,
		);
		console.error(
			`  its \`setup\` commands, if any, then run inside the sandbox.`,
		);
		console.error(
			`  its \`mounts\` ask for host directories to be readable in the sandbox; each is asked about separately.`,
		);
		console.error(
			`  its \`network\` entries decide what the sandbox reaches, ports on this machine included,`,
		);
		console.error(
			`  and a \`secrets\` entry names a credential from your environment that the sandbox may use on those hosts.`,
		);
		console.error(
			`  ${count === 1 ? "1 file" : `${count} files`} will be executed:`,
		);
		console.error("");
		console.error(
			await preview(
				sandbox,
				graph,
				pinned === null ? undefined : record?.files,
			),
		);
		console.error("");

		const ok = await confirm(`  execute ${name} on the host? [y/N] `);
		if (!ok) {
			console.error(`  declined; continuing unmasked.`);
			return skipped(state);
		}
		await pinConfig(sandbox, graph);
	}

	const entry = await snapshot(sandbox, graph);
	return { ...(await importConfig(entry)), legacyIgnore, state, loaded: true };
}

const mountRecord = z.object({ paths: z.array(z.string()) });

function mountRecordPath(sandbox: string): string {
	assertSandboxName(sandbox);
	return join(trustDir(), `${sandbox}.mounts.json`);
}

export async function pinMounts(
	sandbox: string,
	paths: readonly string[],
): Promise<void> {
	await mkdir(trustDir(), { recursive: true });
	await writeFile(
		mountRecordPath(sandbox),
		`${JSON.stringify({ paths }, null, 2)}\n`,
		"utf8",
	);
}

/**
 * The paths a sandbox may mount read-only, asking about each one not approved
 * before. Separate from approving the config: that decides whether the file
 * runs, and only running it says which paths it names.
 *
 * Fails closed like the config: no terminal, or a no, leaves the path out.
 * The record is rewritten to what is approved now, so a path dropped from the
 * config and named again later is asked about again.
 */
export async function approveMounts(
	sandbox: string,
	paths: readonly string[],
): Promise<string[]> {
	let before: string[] = [];
	try {
		before = mountRecord.parse(
			JSON.parse(await readFile(mountRecordPath(sandbox), "utf8")),
		).paths;
	} catch {
		// Never approved anything, or a record we cannot read: ask again.
	}

	const approved: string[] = [];
	for (const dir of paths) {
		// A resolved path can carry a symlink target the guest wrote.
		const shown = escapeUnshowable(dir);
		if (before.includes(dir)) {
			approved.push(dir);
			continue;
		}
		if (!process.stdin.isTTY) {
			console.error(
				`warning: not mounting ${shown}: it is not yet approved, and there is no terminal to ask.`,
			);
			console.error(`  approve it with an interactive: playpen start`);
			continue;
		}
		console.error("");
		console.error(`this project asks to mount ${shown} read-only.`);
		console.error(`  everything in it becomes readable by the sandbox.`);
		if (await confirm(`  allow it? [y/N] `)) approved.push(dir);
		else console.error(`  declined; not mounting it.`);
	}

	const changed =
		before.some((p) => !approved.includes(p)) ||
		approved.some((p) => !before.includes(p));
	if (changed) await pinMounts(sandbox, approved);
	return approved;
}
