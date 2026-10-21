import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { trustDir } from "../config.ts";
import { confirm } from "../prompt.ts";
import { type ConfigGraph, readConfigGraph } from "./configgraph.ts";
import { assertSandboxName } from "./identity.ts";
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
		if (before.includes(dir)) {
			approved.push(dir);
			continue;
		}
		if (!process.stdin.isTTY) {
			console.error(
				`warning: not mounting ${dir}: it is not yet approved, and there is no terminal to ask.`,
			);
			console.error(`  approve it with an interactive: playpen start`);
			continue;
		}
		console.error("");
		console.error(`this project asks to mount ${dir} read-only.`);
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
