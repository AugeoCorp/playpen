import { basename, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { exists } from "../fs.ts";
import { describeIssue } from "../issue.ts";
import { isIpv4, isPort } from "../network/names.ts";
import {
	isEnvName,
	type PortForward,
	parseEntry,
	parseSecretHost,
} from "../network/policy.ts";

export const CONFIG_FILE = "playpen.config.ts";

/** `.js` is accepted so a project without a TypeScript toolchain can still name two directories. */
export const CONFIG_FILES = [CONFIG_FILE, "playpen.config.js"] as const;

/** The file this replaced. Detected only so we can say it is no longer read. */
export const LEGACY_IGNORE_FILE = ".playpenignore";

const networkMode = z.enum(["enforce", "log"], {
	error: 'must be "enforce" or "log"',
});

export type NetworkMode = z.infer<typeof networkMode>;

/**
 * `allow` is matched by name: an entry is a hostname, optionally with a port,
 * and covers that name and everything under it — which is why `*.example.com`
 * is refused rather than read as a longer spelling of `example.com`. The name
 * is checked before it resolves. Named with a port, it may resolve to a LAN
 * address as well as a public one, on that port alone; named without one, it
 * must resolve to a public address, on any port. Neither ever reaches this
 * machine: `localhost:PORT` below is the one entry that does. An IPv4
 * literal is the other way to name a LAN address directly, and it too needs
 * a port, so that one entry cannot reach every service at an address.
 * Link-local addresses and the 0.0.0.0 spelling of loopback are never
 * reached, port or not.
 *
 * `localhost:PORT` means this machine, the one running playpen, not the
 * guest: the guest's own `localhost` never leaves the VM, and it reaches this
 * machine by the name `host.playpen.internal`, which maps to that port only
 * when the entry exists. The port is required.
 *
 * `ports` puts a port on this machine at the guest's own `localhost` too, for
 * a client in the guest that cannot be pointed at `host.playpen.internal`: a
 * number is the same port on both sides, `{ host, guest }` moves it. Each one
 * is a grant of that host port, so it brings its `localhost:<host>` entry
 * with it rather than needing one in `allow`. The guest port has to be free
 * in the guest.
 *
 * `secrets` names credentials from this machine's environment that the
 * sandbox may use on given hosts: `{ env: "GH_TOKEN", hosts: ["github.com"] }`.
 * Names only, never a value: this file sits in the project directory, which
 * the sandbox mounts. The value is read from the environment of the `playpen
 * start` that runs, and nothing is injected yet: in this version an entry is
 * validated and reported and does nothing else. Each host is a plain hostname,
 * not an address and without a port, and is allowed as if it were in `allow`.
 * A mistake in `secrets` fails the load rather than being dropped.
 *
 * `mode: "log"` records verdicts and refuses nothing, for finding out what a
 * project reaches. It is never the default.
 */
export interface NetworkConfig {
	allow?: string[];
	mode?: NetworkMode;
	ports?: Array<number | PortForward>;
	secrets?: Array<{ env: string; hosts: string[] }>;
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

export type LoadedNetwork = Omit<z.output<typeof network>, "rejected">;

export interface LoadedConfig {
	masked: string[];
	setup: string[];
	network: LoadedNetwork;
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

function sift<T>(
	entries: readonly unknown[],
	entry: z.ZodType<T>,
): { kept: T[]; dropped: string[] } {
	const kept: T[] = [];
	const dropped: string[] = [];
	for (const raw of entries) {
		const result = entry.safeParse(raw);
		if (result.success) kept.push(result.data);
		else dropped.push(String(raw));
	}
	return { kept, dropped };
}

/**
 * A list whose bad entries are dropped and kept verbatim for a warning; only a
 * value that is not a list at all fails the load.
 */
function lenientList<T>(entry: z.ZodType<T>) {
	return z
		.array(z.unknown(), { error: "must be an array of strings" })
		.default([])
		.transform((entries) => sift(entries, entry));
}

/**
 * A mask becomes a mount target inside the project, so anything that escapes
 * the project directory would let the config bind-mount over arbitrary guest
 * paths.
 */
const maskEntry = z
	.string()
	.trim()
	.refine((entry) => !entry.startsWith("/"))
	.transform((entry) => normalize(entry).replace(/^\/+|\/+$/g, ""))
	.refine(
		(clean) =>
			clean !== "" &&
			clean !== "." &&
			!clean.startsWith("..") &&
			!clean.includes("*"),
	);

/**
 * Only shape is checked. The command itself is not parsed or restricted: it
 * runs in the guest, which already executes the project's code by design, and
 * a project that wanted to run something could put it in a package script
 * anyway. What matters is that nothing here reaches the host.
 */
const setupEntry = z.string().trim().min(1);

/**
 * An entry names what the guest asks for, not what it ends up connecting to,
 * so anything that is not a name to compare against — a scheme, a path, a
 * wildcard — is dropped rather than guessed at. IPv6 literals are dropped for
 * the same reason and are simply not supported yet. `parseEntry` in
 * network/policy.ts decides all of that, because it is also what matches a
 * request: an entry that passes here cannot mean something else there.
 */
const allowEntry = z.string().transform((raw, ctx) => {
	const entry = parseEntry(raw);
	if (entry !== null) return entry.text;
	ctx.addIssue({ code: "custom", message: "is not a name to allow" });
	return z.NEVER;
});

const PORT_ENTRY =
	"must be a port number or { host, guest }, each from 1 to 65535";

/** A number is the same port on both sides; `{ host, guest }` moves it. */
const portEntry = z.union(
	[
		z
			.number()
			.refine(isPort)
			.transform((port) => ({ host: port, guest: port })),
		z
			.object({ host: z.number(), guest: z.number() })
			.refine(({ host, guest }) => isPort(host) && isPort(guest), {
				error: PORT_ENTRY,
			}),
	],
	{ error: PORT_ENTRY },
);

/**
 * The guest port is what a listener binds, so two entries on one guest port
 * cannot both be honoured; the host port may repeat.
 */
const portForwards = z
	.array(portEntry, {
		error: "must be an array of a port number or { host, guest }",
	})
	.superRefine((forwards, ctx) => {
		const guests = forwards.map((f) => f.guest);
		const twice = guests.find((guest, i) => guests.indexOf(guest) !== i);
		if (twice !== undefined)
			ctx.addIssue({
				code: "custom",
				message: `names guest port ${twice} twice`,
			});
	});

const SECRET_ENV = "must be an environment variable name like GH_TOKEN";

/**
 * A secret is injected into an HTTP header for a named host, so an address or a
 * port has nothing to match. `parseSecretHost` in network/policy.ts decides,
 * because policy.json is read back through it.
 */
const secretHost = z
	.string({ error: "must be a hostname without a port" })
	.transform((raw, ctx) => {
		const host = parseSecretHost(raw);
		if (host !== null) return host;
		ctx.addIssue({
			code: "custom",
			message: isIpv4(raw.trim().replace(/:\d+$/, ""))
				? "must be a hostname, not an address"
				: "must be a hostname without a port",
		});
		return z.NEVER;
	});

/**
 * Loose, then checked for extra keys by hand: a `value` written here would be
 * a secret in a file the guest can read, and zod would otherwise strip it
 * silently.
 */
const secretEntry = z
	.looseObject(
		{
			env: z
				.string({ error: SECRET_ENV })
				.refine(isEnvName, { error: SECRET_ENV }),
			hosts: z
				.array(secretHost, { error: "must be an array of hostnames" })
				.min(1, { error: "must name at least one host" }),
		},
		{ error: "must be { env, hosts }" },
	)
	.refine(
		(entry) => Object.keys(entry).every((k) => k === "env" || k === "hosts"),
		{
			error:
				"must be { env, hosts } and nothing else; a value never goes in this file",
		},
	)
	.transform(({ env, hosts }) => ({ env, hosts }));

/** Two entries for one variable could send it to different hosts by accident. */
const secrets = z
	.array(secretEntry, { error: "must be an array of { env, hosts }" })
	.superRefine((entries, ctx) => {
		const names = entries.map((entry) => entry.env);
		const twice = names.find((name, i) => names.indexOf(name) !== i);
		if (twice !== undefined)
			ctx.addIssue({ code: "custom", message: `names ${twice} twice` });
	});

/**
 * Shape problems — `allow` that is not an array, a `mode` that is neither
 * spelling, any `ports` or `secrets` entry at all that is wrong — fail the load
 * rather than being dropped: a `mode` meant to say "log" that was quietly
 * dropped would enforce instead, a dropped port would leave a client in the
 * guest talking to whatever else holds that port, and a dropped secret would
 * send the placeholder to the real host.
 */
const network = z
	.object(
		{
			allow: lenientList(allowEntry),
			mode: networkMode.default("enforce"),
			ports: portForwards.default([]),
			secrets: secrets.default([]),
		},
		{ error: "must be an object" },
	)
	.prefault({})
	.transform(({ allow, mode, ports, secrets }) => ({
		allow: [...new Set(allow.kept)],
		mode,
		ports,
		secrets,
		rejected: allow.dropped,
	}));

const config = z
	.object(
		{
			masked: lenientList(maskEntry),
			setup: lenientList(setupEntry),
			network,
		},
		{
			error: (issue) =>
				issue.input === undefined
					? "has no default export"
					: "must default-export an object",
		},
	)
	.transform(
		({ masked, setup, network: { rejected, ...loaded } }): LoadedConfig => ({
			masked: masked.kept,
			setup: setup.kept,
			network: loaded,
			rejected: masked.dropped,
			rejectedSetup: setup.dropped,
			rejectedNetwork: rejected,
		}),
	);

export function validateMasks(entries: readonly unknown[]): {
	masked: string[];
	rejected: string[];
} {
	const { kept, dropped } = sift(entries, maskEntry);
	return { masked: kept, rejected: dropped };
}

export function validateSetup(entries: readonly unknown[]): {
	setup: string[];
	rejected: string[];
} {
	const { kept, dropped } = sift(entries, setupEntry);
	return { setup: kept, rejected: dropped };
}

export function validateNetwork(
	raw: unknown,
): LoadedNetwork & { rejected: string[]; error?: string } {
	const result = config.safeParse({ network: raw });
	if (!result.success) {
		return {
			allow: [],
			mode: "enforce",
			ports: [],
			secrets: [],
			rejected: [],
			error: describeIssue(result.error),
		};
	}
	return { ...result.data.network, rejected: result.data.rejectedNetwork };
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
		network: { allow: [], mode: "enforce", ports: [], secrets: [] },
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

	const result = config.safeParse((loaded as { default?: unknown }).default);
	if (result.success) return result.data;
	return { ...empty, error: describeIssue(result.error, name) };
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
			network: { allow: [], mode: "enforce", ports: [], secrets: [] },
			rejected: [],
			rejectedSetup: [],
			rejectedNetwork: [],
			legacyIgnore,
		};
	return { ...(await importConfig(join(projectDir, name))), legacyIgnore };
}
