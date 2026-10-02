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
import { allAdded, unifiedDiff } from "./linediff.ts";
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
 * Characters that draw as nothing, or that a terminal acts on instead of
 * drawing: controls (Cc) other than tab and newline, format characters (Cf:
 * bidi controls, zero-width joiners, tag characters), the line and paragraph
 * separators (Zl, Zp), lone surrogates (Cs), and the Hangul fillers, which
 * JavaScript accepts inside a name but which draw as blank space.
 *
 * Escaping a line terminator does not stop it ending a line for the parser,
 * so it alone cannot keep code from hiding behind a `//`; `linesOf` breaks
 * the displayed line there too.
 */
const UNSHOWABLE =
	/(?![\t\n])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\u115F\u1160\u3164\uFFA0]/gu;

export function escapeControls(text: string): string {
	return text.replace(UNSHOWABLE, (c) => {
		if (c === "\r") return "\\r";
		const code = c.codePointAt(0) ?? 0;
		return code < 0x80
			? `\\x${code.toString(16).padStart(2, "0")}`
			: `\\u{${code.toString(16)}}`;
	});
}

/**
 * A line ends wherever JavaScript ends one (ECMA-262, LineTerminator): at a
 * lone `\r`, U+2028 and U+2029 as well as `\n`. Each terminator but `\n` stays
 * on the line it ends, to be escaped there, so the code after it starts a line
 * of its own on screen just as it does to the parser.
 */
function linesOf(contents: string): string[] {
	return contents
		.split(/(?<=\n|\r(?!\n)|\u2028|\u2029)/)
		.map((line) => line.replace(/\n$/, ""));
}

/**
 * The snapshot is under the data directory, which no guest mounts, but it is
 * still only used if it hashes to what the record says was approved.
 */
async function approvedCopy(
	sandbox: string,
	rel: string,
	hash: string,
): Promise<{ contents: string } | { missing: string }> {
	let contents: string;
	try {
		contents = await readFile(join(snapshotDir(sandbox), rel), "utf8");
	} catch {
		return { missing: "no approved copy to compare with" };
	}
	return sha256(contents) === hash
		? { contents }
		: { missing: "the approved copy does not match its hash" };
}

interface FileView {
	note: string;
	lines: string[];
}

/**
 * A changed file is diffed from the in-memory bytes that were just hashed,
 * never the file on disk, which the guest can rewrite after hashing. Every
 * line is shown, not just those near a change: an edit can change what an
 * untouched line far from it means, such as closing a template literal that
 * held it. A file
 * shown whole is shown as all added, so none of its lines can pass for a
 * removed or unchanged one.
 */
async function viewOf(
	sandbox: string,
	f: GraphFile,
	approvedHash: string | undefined,
): Promise<FileView> {
	const whole = (note: string): FileView => ({
		note,
		lines: allAdded(linesOf(f.contents)),
	});
	if (approvedHash === undefined) return whole("new");
	if (approvedHash === f.hash) return { note: "unchanged", lines: [] };
	const old = await approvedCopy(sandbox, f.rel, approvedHash);
	if ("missing" in old) return whole(`changed, shown whole: ${old.missing}`);
	const diff = unifiedDiff(
		linesOf(old.contents),
		linesOf(f.contents),
		Number.POSITIVE_INFINITY,
	);
	if (diff === null) return whole("changed, shown whole: too long to diff");
	if (diff.length === 0)
		return {
			note: "changed: only the newline at the end of the file",
			lines: [],
		};
	return { note: "changed", lines: diff };
}

const COLOUR: Record<string, string> = { "-": "31", "+": "32", "@": "36" };

function paint(line: string): string {
	const code = COLOUR[line[0] ?? ""];
	return code === undefined ? line : `\x1b[${code}m${line}\x1b[0m`;
}

/**
 * Names and contents come from a directory the guest can write, so both are
 * printed escaped, and a last line names the files that needed it.
 */
export async function previewApproval(
	sandbox: string,
	graph: ConfigGraph,
	colour = false,
): Promise<string> {
	const record = await readRecord(sandbox);
	const approved = new Map(
		record?.file === graph.entry ? Object.entries(record.files) : [],
	);
	const out: string[] = [];
	const escaped = new Set<string>();
	const heading = (rel: string, note: string): void => {
		const name = escapeControls(rel);
		if (name !== rel) escaped.add(name);
		out.push(`  ── ${name} (${note})`);
	};

	for (const f of graph.files) {
		const view = await viewOf(sandbox, f, approved.get(f.rel));
		heading(f.rel, view.note);
		const shown = view.lines.map(escapeControls);
		if (shown.some((line, i) => line !== view.lines[i]))
			escaped.add(escapeControls(f.rel));
		for (const line of shown) out.push(`  │ ${colour ? paint(line) : line}`);
	}
	const kept = new Set(graph.files.map((f) => f.rel));
	for (const rel of approved.keys()) {
		if (!kept.has(rel)) heading(rel, "removed");
	}

	if (escaped.size > 0) {
		out.push(
			"",
			`  warning: invisible or control characters, shown above as escapes like \\x1b or \\u{200d}, in: ${[...escaped].join(", ")}`,
		);
	}
	return out.join("\n");
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
		setup: [],
		network: { allow: [], mode: "enforce", ports: [], secrets: [] },
		rejected: [],
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
			await previewApproval(sandbox, graph, process.stderr.isTTY === true),
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
