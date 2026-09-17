import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exists } from "../fs.ts";
import * as lima from "../lima/client.ts";
import { captureBuffer } from "../sh.ts";

export interface SyncEntry {
	/** Path relative to ~/.claude. Directories are copied recursively. */
	path: string;
	why: string;
	/** Only copied when credentials are explicitly requested. */
	secret?: boolean;
}

/**
 * Everything copied verbatim into the guest's ~/.claude.
 *
 * An allowlist, not a denylist. ~/.claude also holds every session transcript,
 * shell history, and per-project memories for unrelated projects. Anything new
 * appearing there stays out until added here deliberately.
 */
export const SYNC_SET: SyncEntry[] = [
	{ path: "CLAUDE.md", why: "global instructions and preferences" },
	{ path: "skills", why: "custom skills" },
	{ path: "plugins", why: "installed plugins" },
	{ path: ".credentials.json", why: "OAuth token", secret: true },
];

/** Rewritten in transit rather than copied; see filterSettings. */
const SETTINGS = "settings.json";

/**
 * Account and onboarding state lives in ~/.claude.json, outside ~/.claude.
 * Without it the guest looks like a first run and asks you to log in even
 * though credentials are present. Rewritten in transit; see filterClaudeJson.
 */
const CLAUDE_JSON = ".claude.json";

export interface PushOptions {
	/** Copy instructions, settings, skills and plugins. */
	includeConfig: boolean;
	/** Copy the OAuth token, the API-key settings, and the account identity. */
	includeCredentials: boolean;
	/** Absolute project path, used to scope the ~/.claude.json projects map. */
	projectDir: string;
	/** Skip the copy when the source is unchanged since this hash. */
	skipIfHash?: string;
}

export interface PushResult {
	pushed: string[];
	missing: string[];
	bytes: number;
	/** Fingerprint of the source; store it to skip an unchanged re-push. */
	hash: string;
	skipped: boolean;
	error?: string;
}

function claudeDir(): string {
	return join(homedir(), ".claude");
}

function selected(opts: PushOptions): SyncEntry[] {
	return SYNC_SET.filter((e) =>
		e.secret ? opts.includeCredentials : opts.includeConfig,
	);
}

/**
 * Size-and-mtime fingerprint of everything that would be pushed, plus the
 * options that shape the rewrite. plugins/ alone is tens of MB, so hashing
 * metadata rather than contents keeps this stat-bound.
 */
async function fingerprint(
	paths: string[],
	opts: PushOptions,
): Promise<string> {
	const entries: string[] = [
		opts.projectDir,
		`config:${opts.includeConfig}`,
		`credentials:${opts.includeCredentials}`,
	];

	for (const abs of paths) {
		const info = await stat(abs).catch(() => null);
		if (!info) continue;
		if (!info.isDirectory()) {
			entries.push(`${abs}:${info.size}:${info.mtimeMs}`);
			continue;
		}
		for (const child of (await readdir(abs, { recursive: true })).sort()) {
			try {
				const s = await stat(join(abs, child));
				if (s.isFile()) entries.push(`${abs}/${child}:${s.size}:${s.mtimeMs}`);
			} catch {
				// Raced with a delete; the next sync will catch up.
			}
		}
	}

	return createHash("sha256")
		.update(entries.join("\n"))
		.digest("hex")
		.slice(0, 16);
}

/**
 * settings.json keys that can carry an API key or fetch one: `env` holds
 * ANTHROPIC_API_KEY and friends, the rest are helper commands that print
 * credentials. Dropped unless credentials were asked for.
 */
const CREDENTIAL_SETTINGS = [
	"env",
	"apiKeyHelper",
	"awsAuthRefresh",
	"awsCredentialExport",
];

export function filterSettings(
	raw: string,
	includeCredentials: boolean,
): string {
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	if (!includeCredentials) {
		for (const key of CREDENTIAL_SETTINGS) delete parsed[key];
	}
	return JSON.stringify(parsed, null, 2);
}

/**
 * Top-level ~/.claude.json keys that reach the guest.
 *
 * A keep-list, not a denylist, for the same reason SYNC_SET is: Claude Code
 * adds top-level keys regularly, and an earlier version that passed unknown
 * keys through let `githubRepoPaths` cross, naming every repo cloned on the
 * host. Deliberately absent: `mcpServers`, whose definitions can carry
 * tokens; the `*Cache` keys, which name other projects and orgs; and usage
 * telemetry. None of it is load-bearing inside a sandbox.
 */
const KEEP_KEYS: readonly string[] = [
	"hasCompletedOnboarding",
	"firstStartTime",
	"numStartups",
	"installMethod",
	"migrationVersion",
	"lastOnboardingVersion",
	"theme",
	"autoUpdates",
	"shiftEnterKeyBindingInstalled",
];

/** Who is logged in. Kept only when credentials are, since it is half of a login. */
const IDENTITY_KEYS: readonly string[] = ["oauthAccount", "userID"];

/**
 * `projects` is kept but narrowed to this project: its entry carries the
 * directory-trust flag that suppresses the "do you trust these files" prompt,
 * while the map as a whole names every directory you have ever opened.
 */
export function filterClaudeJson(
	raw: string,
	projectDir: string,
	includeCredentials = true,
): string {
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const kept: Record<string, unknown> = {};

	const keys = includeCredentials
		? [...IDENTITY_KEYS, ...KEEP_KEYS]
		: KEEP_KEYS;
	for (const key of keys) {
		if (key in parsed) kept[key] = parsed[key];
	}

	const projects = parsed.projects;
	if (projects && typeof projects === "object") {
		const map = projects as Record<string, unknown>;
		const mine = map[projectDir];
		kept.projects = mine === undefined ? {} : { [projectDir]: mine };
	}

	return JSON.stringify(kept, null, 2);
}

/** Write `contents` to `$HOME/<rel>` in the guest, private to the guest user. */
async function pushFile(
	instance: string,
	rel: string,
	contents: string,
): Promise<string | null> {
	const script = [
		"set -eu",
		"umask 077",
		`mkdir -p "$(dirname "$HOME/${rel}")"`,
		`cat > "$HOME/${rel}"`,
	].join("\n");
	const result = await lima.shellInput(
		instance,
		["sh", "-c", script],
		contents,
	);
	return result.code === 0
		? null
		: result.stderr.trim() || `limactl shell exited ${result.code}`;
}

async function pushRewritten(
	instance: string,
	hostPath: string,
	guestRel: string,
	rewrite: (raw: string) => string,
): Promise<string | null> {
	let raw: string;
	try {
		raw = await readFile(hostPath, "utf8");
	} catch {
		return `no ${hostPath} on the host`;
	}
	let filtered: string;
	try {
		filtered = rewrite(raw);
	} catch {
		return `${hostPath} is not valid JSON`;
	}
	return pushFile(instance, guestRel, filtered);
}

/**
 * The verbatim entries travel as one tar through stdin: it carries directory
 * structure and modes in one pass, and keeps credential contents out of argv.
 * The rewritten files follow, so an extract can never clobber them.
 */
export async function pushClaudeConfig(
	instance: string,
	opts: PushOptions,
): Promise<PushResult> {
	const present: string[] = [];
	const missing: string[] = [];
	for (const entry of selected(opts)) {
		if (await exists(join(claudeDir(), entry.path))) present.push(entry.path);
		else missing.push(entry.path);
	}

	const settingsPath = join(claudeDir(), SETTINGS);
	const claudeJsonPath = join(homedir(), CLAUDE_JSON);
	const wantSettings = opts.includeConfig && (await exists(settingsPath));
	const wantClaudeJson =
		(opts.includeConfig || opts.includeCredentials) &&
		(await exists(claudeJsonPath));

	if (present.length === 0 && !wantSettings && !wantClaudeJson) {
		return {
			pushed: [],
			missing,
			bytes: 0,
			hash: "",
			skipped: false,
			error: "nothing to copy",
		};
	}

	const sources = present.map((p) => join(claudeDir(), p));
	if (wantSettings) sources.push(settingsPath);
	if (wantClaudeJson) sources.push(claudeJsonPath);
	const hash = await fingerprint(sources, opts);
	if (opts.skipIfHash && opts.skipIfHash === hash) {
		return { pushed: [], missing, bytes: 0, hash, skipped: true };
	}

	const fail = (
		error: string,
		pushed: string[] = [],
		bytes = 0,
	): PushResult => ({
		pushed,
		missing,
		bytes,
		hash,
		skipped: false,
		error,
	});

	const pushed: string[] = [];
	let bytes = 0;

	if (present.length > 0) {
		const tar = await captureBuffer("tar", [
			"-chf",
			"-",
			"-C",
			claudeDir(),
			...present,
		]);
		if (tar.code !== 0)
			return fail(tar.stderr.trim() || `tar exited ${tar.code}`);
		bytes = tar.stdout.length;

		const script = [
			"set -eu",
			"umask 077",
			'mkdir -p "$HOME/.claude"',
			'tar -xf - -C "$HOME/.claude"',
		].join("\n");
		const result = await lima.shellInput(
			instance,
			["sh", "-c", script],
			tar.stdout,
		);
		if (result.code !== 0) {
			return fail(
				result.stderr.trim() || `limactl shell exited ${result.code}`,
				[],
				bytes,
			);
		}
		pushed.push(...present);
	}

	if (wantSettings) {
		const err = await pushRewritten(
			instance,
			settingsPath,
			`.claude/${SETTINGS}`,
			(raw) => filterSettings(raw, opts.includeCredentials),
		);
		if (err) return fail(`${SETTINGS} not copied (${err})`, pushed, bytes);
		pushed.push(SETTINGS);
	}

	if (wantClaudeJson) {
		const err = await pushRewritten(
			instance,
			claudeJsonPath,
			CLAUDE_JSON,
			(raw) => filterClaudeJson(raw, opts.projectDir, opts.includeCredentials),
		);
		if (err) {
			return fail(
				`${CLAUDE_JSON} not copied (${err}) — the guest will ask you to log in`,
				pushed,
				bytes,
			);
		}
		pushed.push(CLAUDE_JSON);
	}

	return { pushed, missing, bytes, hash, skipped: false };
}
