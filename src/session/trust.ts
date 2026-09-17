import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { trustDir } from "../config.ts";
import { confirm } from "../prompt.ts";
import { type ConfigGraph, readConfigGraph } from "./configgraph.ts";
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

interface TrustRecord {
	/** Hash of the whole approved graph. */
	hash: string;
	/** Which of CONFIG_FILES was approved, so a rename is not silently inherited. */
	file: string;
	/** Per-file hashes, so a re-prompt can say which files moved. */
	files: Record<string, string>;
	approved: string;
}

function assertSandboxName(sandbox: string): void {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(sandbox)) {
		throw new Error(`invalid sandbox name: ${JSON.stringify(sandbox)}`);
	}
}

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
		return JSON.parse(
			await readFile(recordPath(sandbox), "utf8"),
		) as TrustRecord;
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

function preview(
	graph: ConfigGraph,
	approved: Record<string, string> | undefined,
): string {
	const out: string[] = [];
	for (const f of graph.files) {
		const before = approved?.[f.rel];
		const status =
			before === undefined
				? "new"
				: before === f.hash
					? "unchanged"
					: "changed";
		out.push(`  ── ${f.rel} (${status})`);
		if (status === "unchanged") continue;
		for (const line of f.contents.replace(/\n$/, "").split("\n"))
			out.push(`  │ ${line}`);
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
		network: { allow: [], mode: "enforce" },
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
	const pinned =
		record && record.file === name && record.files ? record.hash : null;
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
			`  ${count === 1 ? "1 file" : `${count} files`} will be executed:`,
		);
		console.error("");
		console.error(preview(graph, pinned === null ? undefined : record?.files));
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
