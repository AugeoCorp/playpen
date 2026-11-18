import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, relative, resolve } from "node:path";
import { dataDir, limaHome } from "../config.ts";
import { exists } from "../fs.ts";

export interface GuardResult {
	ok: boolean;
	reason?: string;
	warning?: string;
}

export interface GuardEnv {
	home: string;
	/** Directories the guest must never be able to write, on top of home and the system. */
	protectedDirs: string[];
}

/**
 * The data dir holds the config approvals, Lima's home holds its SSH keys and
 * disks, and ~/.claude holds every transcript. A guest with any of them
 * mounted read-write could approve its own config or read its way out.
 */
export function hostEnv(): GuardEnv {
	const home = resolve(homedir());
	return {
		home,
		protectedDirs: [dataDir(), limaHome(), join(home, ".claude")],
	};
}

const SYSTEM_DIRS = ["/etc", "/usr", "/var", "/boot", "/nix", "/tmp"];

function contains(parent: string, child: string): boolean {
	return child.startsWith(`${parent}/`);
}

/**
 * The same lines hold for a read-only mount: reading the data directory gives
 * away every other sandbox's history, and Lima's home holds its SSH keys.
 */
function refusal(
	abs: string,
	home: string,
	protectedDirs: readonly string[],
	access: "read" | "write",
): string | null {
	if (abs === parse(abs).root) return "refusing to mount the filesystem root";
	if (abs === home) {
		return access === "write"
			? `refusing to mount your home directory (${home}) read-write into a sandbox. ` +
					`Run playpen from inside a project instead.`
			: `refusing to mount your home directory (${home}) into a sandbox`;
	}
	if (contains(abs, home)) {
		return `refusing to mount ${abs}: it contains your home directory`;
	}
	if (SYSTEM_DIRS.includes(abs)) {
		return `refusing to mount system directory ${abs}`;
	}
	for (const guarded of protectedDirs) {
		if (abs === guarded || contains(abs, guarded)) {
			return `refusing to mount ${abs}: it contains ${guarded}, which the sandbox must not be able to ${access}`;
		}
		if (contains(guarded, abs)) {
			return `refusing to mount ${abs}: it is inside ${guarded}, which the sandbox must not be able to ${access}`;
		}
	}
	return null;
}

/**
 * Refuse to mount directories where a writable mount would be reckless.
 *
 * The sandbox exists to keep an agent away from your host filesystem. Mounting
 * $HOME or / hands back everything it was meant to withhold, so those are hard
 * refusals rather than warnings.
 */
export async function checkMount(
	dir: string,
	env: GuardEnv = hostEnv(),
): Promise<GuardResult> {
	const abs = resolve(dir);
	const reason = refusal(
		abs,
		resolve(env.home),
		env.protectedDirs.map((p) => resolve(p)),
		"write",
	);
	if (reason !== null) return { ok: false, reason };

	if (!(await exists(join(abs, ".git")))) {
		return {
			ok: true,
			warning: `${abs} is not a git repository — an agent's changes here are not recoverable via git`,
		};
	}
	return { ok: true };
}

export type ReadOnlyMount =
	| { ok: true; path: string }
	| { ok: false; reason: string };

/** Compared by real path, so a symlink to a protected directory is caught too. */
async function real(path: string): Promise<string> {
	return realpath(path).catch(() => resolve(path));
}

/**
 * Where a `mounts` entry points on this machine, or why it cannot be mounted.
 *
 * Resolved through symlinks before any check, because the guest sees the
 * directory, not the link: a link inside a sibling repo to ~/.ssh is ~/.ssh.
 * Overlap with the project is refused both ways, since one 9p share inside
 * another, writable over read-only or the reverse, makes either flag a lie.
 */
export async function checkReadOnlyMount(
	entry: string,
	project: string,
	env: GuardEnv = hostEnv(),
): Promise<ReadOnlyMount> {
	if (entry.startsWith("~") && entry !== "~" && !entry.startsWith("~/")) {
		return {
			ok: false,
			reason: `not mounting ${entry}: only ~/ is expanded, not another user's ~name`,
		};
	}
	const written =
		entry === "~" || entry.startsWith("~/")
			? join(env.home, entry.slice(1))
			: resolve(project, entry);

	let abs: string;
	try {
		abs = await realpath(written);
		if (!(await stat(abs)).isDirectory()) {
			return {
				ok: false,
				reason: `not mounting ${entry}: ${abs} is not a directory`,
			};
		}
	} catch {
		return {
			ok: false,
			reason: `not mounting ${entry}: ${written} does not exist`,
		};
	}

	const home = await real(env.home);
	const reason = refusal(
		abs,
		home,
		await Promise.all(env.protectedDirs.map(real)),
		"read",
	);
	if (reason !== null) return { ok: false, reason };

	// Credentials live in ~/.ssh, ~/.aws, ~/.config/<tool> and wherever else a
	// tool chose, so no list of them is ever complete. Every top-level dot
	// directory is refused instead, package caches like ~/.m2 with them.
	const hidden = contains(home, abs) && relative(home, abs).startsWith(".");
	if (hidden) {
		return {
			ok: false,
			reason: `refusing to mount ${abs}: directories under ~/.* are where credentials live`,
		};
	}

	const shared = await real(project);
	if (abs === shared || contains(abs, shared) || contains(shared, abs)) {
		return {
			ok: false,
			reason: `refusing to mount ${abs} read-only: it overlaps the project, which is mounted read-write`,
		};
	}
	return { ok: true, path: abs };
}
