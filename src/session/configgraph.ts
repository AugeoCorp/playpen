import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface GraphFile {
	/** Project-relative path. */
	rel: string;
	contents: string;
	hash: string;
}

/**
 * The config file plus every project file it statically imports, transitively.
 *
 * What gets approved and executed is this set, not the config file alone: an
 * agent that cannot change a pinned `playpen.config.ts` can still change the
 * module it imports. Hashing the graph closes that. It covers what a static
 * scan can see — `import`, `export … from`, `import()` and `require()` with a
 * literal specifier. Anything loaded dynamically is visible in the source you
 * approve, which is where a reviewer would expect to find it.
 */
export interface ConfigGraph {
	entry: string;
	files: GraphFile[];
	hash: string;
}

export class UnpinnableImport extends Error {
	constructor(from: string, specifier: string, why: string) {
		super(`${from} imports ${JSON.stringify(specifier)}, ${why}`);
		this.name = "UnpinnableImport";
	}
}

const SPECIFIER =
	/\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1|\bimport\s*(['"])([^'"]+)\3|\b(?:import|require)\s*\(\s*(['"])([^'"]+)\5\s*\)/g;

/** `import type` and `export type` are erased before Node resolves anything, so they load nothing. */
const TYPE_ONLY = /^(?:import|export)\s+type\b/;

export function findSpecifiers(source: string): string[] {
	const found: string[] = [];
	for (const m of source.matchAll(SPECIFIER)) {
		if (TYPE_ONLY.test(m[0])) continue;
		const spec = m[2] ?? m[4] ?? m[6];
		if (spec !== undefined) found.push(spec);
	}
	return found;
}

function sha256(contents: string): string {
	return createHash("sha256").update(contents).digest("hex");
}

/**
 * Where Node will look for a specifier, or null for a builtin.
 *
 * Only path-shaped specifiers are accepted. A bare package name resolves
 * through node_modules, whose layout (exports maps, conditions) cannot be
 * mirrored exactly by a static scan, so a package cannot be pinned honestly.
 */
function resolveSpecifier(
	specifier: string,
	fromFile: string,
	fromRel: string,
): string | null {
	let spec = specifier.split(/[?#]/, 1)[0] ?? "";
	try {
		spec = decodeURIComponent(spec);
	} catch {
		// Node would fail to load it too; leave it as written.
	}

	if (spec.startsWith("node:") || isBuiltin(spec)) return null;
	if (spec.startsWith("./") || spec.startsWith("../"))
		return resolve(dirname(fromFile), spec);
	if (spec.startsWith("file:")) return fileURLToPath(spec);
	if (isAbsolute(spec)) return spec;

	throw new UnpinnableImport(
		fromRel,
		specifier,
		"a package; only project files can be pinned",
	);
}

export async function readConfigGraph(
	projectDir: string,
	entryName: string,
): Promise<ConfigGraph> {
	const root = resolve(projectDir);
	const files = new Map<string, GraphFile>();
	const queue: string[] = [resolve(root, entryName)];

	while (queue.length > 0) {
		const abs = queue.shift() as string;
		if (files.has(abs)) continue;

		let contents: string;
		try {
			contents = await readFile(abs, "utf8");
		} catch {
			if (abs === resolve(root, entryName))
				throw new Error(`${entryName} is not readable`);
			continue;
		}

		const rel = relative(root, abs);
		files.set(abs, { rel, contents, hash: sha256(contents) });

		for (const spec of findSpecifiers(contents)) {
			const target = resolveSpecifier(spec, abs, rel);
			if (target === null) continue;
			const targetRel = relative(root, target);
			if (targetRel.startsWith("..") || isAbsolute(targetRel)) {
				throw new UnpinnableImport(
					rel,
					spec,
					"which is outside the project and cannot be pinned",
				);
			}
			queue.push(target);
		}
	}

	const sorted = [...files.values()].sort((a, b) =>
		a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0,
	);
	const hash = sha256(sorted.map((f) => `${f.rel}\0${f.hash}`).join("\n"));
	return { entry: entryName, files: sorted, hash };
}
