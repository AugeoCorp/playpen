import { basename, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { exists } from "../fs.ts";

export const CONFIG_FILE = "playpen.config.ts";

/** `.js` is accepted so a project without a TypeScript toolchain can still name two directories. */
export const CONFIG_FILES = [CONFIG_FILE, "playpen.config.js"] as const;

/** The file this replaced. Detected only so we can say it is no longer read. */
export const LEGACY_IGNORE_FILE = ".playpenignore";

export interface PlaypenConfig {
	/**
	 * Project-relative paths given guest-local storage instead of the 9p share.
	 *
	 * Two reasons, neither of them privacy: the 9p share is slow, and host and
	 * guest frequently need different contents at the same path — native modules
	 * and toolchain builds are per-platform, so one copy cannot serve both.
	 *
	 * Masked, not hidden: the host directory stays mounted underneath, and the
	 * guest has passwordless root and can unmount the mask. Keep secrets outside
	 * the project directory.
	 *
	 * One concrete relative path per entry; a bind mount needs a single target,
	 * so globs are unsupported.
	 */
	masked?: string[];

	/**
	 * Shell commands run in the guest, in order, on create and after a rebuild.
	 * `playpen setup` re-runs them.
	 *
	 * Declared rather than inferred: a masked `node_modules` is empty in a new
	 * sandbox, but `npm ci`, `pnpm i` and `uv sync` are not interchangeable, so
	 * guessing from a lockfile would be wrong often enough to be worse than
	 * saying nothing.
	 */
	setup?: string[];
}

/**
 * Optional: a plain `export default { masked: [...] }` works identically, which
 * matters because a project you sandbox will rarely have playpen installed.
 */
export function defineConfig(config: PlaypenConfig): PlaypenConfig {
	return config;
}

export interface LoadedConfig {
	masked: string[];
	setup: string[];
	/** `masked` entries dropped by validation, verbatim, for warning about. */
	rejected: string[];
	/** `setup` entries dropped by validation, verbatim. */
	rejectedSetup: string[];
	/** Set when the file exists but could not be loaded. Masking is skipped. */
	error?: string;
}

export interface ConfigResult extends LoadedConfig {
	legacyIgnore: boolean;
}

/**
 * A mask becomes a mount target inside the project, so anything that escapes
 * the project directory would let the config bind-mount over arbitrary guest
 * paths.
 */
export function validateMasks(entries: readonly unknown[]): {
	masked: string[];
	rejected: string[];
} {
	const masked: string[] = [];
	const rejected: string[] = [];

	for (const raw of entries) {
		if (typeof raw !== "string") {
			rejected.push(String(raw));
			continue;
		}

		const entry = raw.trim();
		const clean = normalize(entry).replace(/^\/+|\/+$/g, "");

		if (
			clean === "" ||
			clean === "." ||
			clean.startsWith("..") ||
			entry.startsWith("/")
		) {
			rejected.push(raw);
			continue;
		}
		if (clean.includes("*")) {
			rejected.push(raw);
			continue;
		}
		masked.push(clean);
	}

	return { masked, rejected };
}

/**
 * Only shape is checked. The command itself is not parsed or restricted: it
 * runs in the guest, which already executes the project's code by design, and
 * a project that wanted to run something could put it in a package script
 * anyway. What matters is that nothing here reaches the host.
 */
export function validateSetup(entries: readonly unknown[]): {
	setup: string[];
	rejected: string[];
} {
	const setup: string[] = [];
	const rejected: string[] = [];

	for (const raw of entries) {
		if (typeof raw !== "string" || raw.trim() === "") {
			rejected.push(String(raw));
			continue;
		}
		setup.push(raw.trim());
	}

	return { setup, rejected };
}

export async function hasLegacyIgnore(projectDir: string): Promise<boolean> {
	return exists(join(projectDir, LEGACY_IGNORE_FILE));
}

/** The config filename present in the project, or null. */
export async function findConfigFile(
	projectDir: string,
): Promise<string | null> {
	for (const name of CONFIG_FILES) {
		if (await exists(join(projectDir, name))) return name;
	}
	return null;
}

function explain(err: unknown): string {
	const code = (err as { code?: string } | null)?.code;
	if (code === "ERR_UNKNOWN_FILE_EXTENSION" || code === "ERR_NO_TYPESCRIPT") {
		return `this Node (${process.version}) cannot import TypeScript; playpen needs Node >=23.6 on the host`;
	}
	return err instanceof Error ? err.message : String(err);
}

/**
 * Execute a config file and validate its default export.
 *
 * This runs the file's code in the host process. Nothing here checks whether
 * that code was approved; callers loading a project's own config must go
 * through `loadTrustedConfig` in trust.ts, which hands this a snapshot of an
 * approved graph.
 */
export async function importConfig(file: string): Promise<LoadedConfig> {
	const name = basename(file);
	const empty: LoadedConfig = {
		masked: [],
		setup: [],
		rejected: [],
		rejectedSetup: [],
	};

	let loaded: unknown;
	try {
		loaded = await import(pathToFileURL(file).href);
	} catch (err) {
		return { ...empty, error: explain(err) };
	}

	const config = (loaded as { default?: unknown }).default;
	if (config === undefined) {
		return { ...empty, error: `${name} has no default export` };
	}
	if (typeof config !== "object" || config === null) {
		return { ...empty, error: `${name} must default-export an object` };
	}

	const { masked, setup } = config as PlaypenConfig;
	if (masked !== undefined && !Array.isArray(masked)) {
		return {
			...empty,
			error: `${name}: \`masked\` must be an array of strings`,
		};
	}
	if (setup !== undefined && !Array.isArray(setup)) {
		return {
			...empty,
			error: `${name}: \`setup\` must be an array of strings`,
		};
	}

	const masks = validateMasks(masked ?? []);
	const steps = validateSetup(setup ?? []);
	return {
		masked: masks.masked,
		setup: steps.setup,
		rejected: masks.rejected,
		rejectedSetup: steps.rejected,
	};
}

/** Ungated: executes the project's config in place. See `importConfig`. */
export async function loadProjectConfig(
	projectDir: string,
): Promise<ConfigResult> {
	const legacyIgnore = await hasLegacyIgnore(projectDir);
	const name = await findConfigFile(projectDir);
	if (name === null)
		return {
			masked: [],
			setup: [],
			rejected: [],
			rejectedSetup: [],
			legacyIgnore,
		};
	return { ...(await importConfig(join(projectDir, name))), legacyIgnore };
}
