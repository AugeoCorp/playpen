import { basename, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { exists } from "../fs.ts";
import { parseEntry } from "../network/policy.ts";

export const CONFIG_FILE = "playpen.config.ts";

/** `.js` is accepted so a project without a TypeScript toolchain can still name two directories. */
export const CONFIG_FILES = [CONFIG_FILE, "playpen.config.js"] as const;

/** The file this replaced. Detected only so we can say it is no longer read. */
export const LEGACY_IGNORE_FILE = ".playpenignore";

export type NetworkMode = "enforce" | "log";

/**
 * `allow` is matched by name: an entry is a hostname, optionally with a port,
 * and covers that name and everything under it — which is why `*.example.com`
 * is refused rather than read as a longer spelling of `example.com`. The name
 * is checked before it resolves. Named with a port, it may resolve inside —
 * to this machine's own loopback or a LAN address — on that port alone;
 * named without one, it must resolve to a public address, on any port. An
 * IPv4 literal is the other way to name a LAN address directly, and it too
 * needs a port, so that one entry cannot reach every service at an address.
 * Link-local addresses and the 0.0.0.0 spelling of loopback are never
 * reached, port or not.
 *
 * `mode: "log"` records verdicts and refuses nothing, for finding out what a
 * project reaches. It is never the default.
 */
export interface NetworkConfig {
	allow?: string[];
	mode?: NetworkMode;
}

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

	/**
	 * Hosts this project may reach, on top of the list playpen ships. Every
	 * outbound connection from the sandbox is checked against the two together.
	 */
	network?: NetworkConfig;
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
	network: { allow: string[]; mode: NetworkMode };
	/** `masked` entries dropped by validation, verbatim, for warning about. */
	rejected: string[];
	/** `setup` entries dropped by validation, verbatim. */
	rejectedSetup: string[];
	/** `network.allow` entries dropped by validation, verbatim. */
	rejectedNetwork: string[];
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

/**
 * An entry names what the guest asks for, not what it ends up connecting to,
 * so anything that is not a name to compare against — a scheme, a path, a
 * wildcard — is dropped rather than guessed at. IPv6 literals are dropped for
 * the same reason and are simply not supported yet. `parseEntry` in
 * network/policy.ts decides all of that, because it is also what matches a
 * request: an entry that passes here cannot mean something else there.
 *
 * Shape problems — `allow` that is not an array, a `mode` that is neither
 * spelling — come back as `error` rather than as dropped entries: a `mode`
 * meant to say "log" that was quietly dropped would enforce instead.
 */
export function validateNetwork(raw: unknown): {
	allow: string[];
	mode: NetworkMode;
	rejected: string[];
	error?: string;
} {
	const none = { allow: [], mode: "enforce" as const, rejected: [] };
	if (raw === undefined) return none;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ...none, error: "`network` must be an object" };
	}

	const { allow, mode } = raw as NetworkConfig;
	if (allow !== undefined && !Array.isArray(allow)) {
		return { ...none, error: "`network.allow` must be an array of strings" };
	}
	if (mode !== undefined && mode !== "enforce" && mode !== "log") {
		return { ...none, error: '`network.mode` must be "enforce" or "log"' };
	}

	const entries: readonly unknown[] = allow ?? [];
	const accepted: string[] = [];
	const rejected: string[] = [];

	for (const entry of entries) {
		if (typeof entry !== "string") {
			rejected.push(String(entry));
			continue;
		}
		const parsed = parseEntry(entry);
		if (parsed === null) {
			rejected.push(entry);
			continue;
		}
		if (!accepted.includes(parsed.text)) accepted.push(parsed.text);
	}

	return { allow: accepted, mode: mode ?? "enforce", rejected };
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
		network: { allow: [], mode: "enforce" },
		rejected: [],
		rejectedSetup: [],
		rejectedNetwork: [],
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

	const { masked, network, setup } = config as PlaypenConfig;
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

	const net = validateNetwork(network);
	if (net.error !== undefined) {
		return { ...empty, error: `${name}: ${net.error}` };
	}

	const masks = validateMasks(masked ?? []);
	const steps = validateSetup(setup ?? []);
	return {
		masked: masks.masked,
		setup: steps.setup,
		network: { allow: net.allow, mode: net.mode },
		rejected: masks.rejected,
		rejectedSetup: steps.rejected,
		rejectedNetwork: net.rejected,
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
			network: { allow: [], mode: "enforce" },
			rejected: [],
			rejectedSetup: [],
			rejectedNetwork: [],
			legacyIgnore,
		};
	return { ...(await importConfig(join(projectDir, name))), legacyIgnore };
}
