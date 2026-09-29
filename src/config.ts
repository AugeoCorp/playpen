import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxOptions } from "./image/render.ts";

export interface Config {
	cpus: number;
	memory: string;
	disk: string;
	mountType: SandboxOptions["mountType"];
}

/**
 * 9p is Lima's default for QEMU since v1.0 and the best-tested option on a Linux
 * host; virtiofs is faster but still experimental there. Revisit with numbers.
 */
export const defaults: Config = {
	cpus: 4,
	memory: "8GiB",
	disk: "60GiB",
	mountType: "9p",
};

export function dataDir(): string {
	const xdg = process.env.XDG_DATA_HOME;
	const base = xdg && xdg !== "" ? xdg : join(homedir(), ".local", "share");
	return join(base, "playpen");
}

export function sessionsDir(): string {
	return join(dataDir(), "sessions");
}

/** Kept on disk so a failed boot can be inspected. */
export function templatesDir(): string {
	return join(dataDir(), "templates");
}

/**
 * One directory per sandbox, mounted at its guest's `~/.claude/projects`, and
 * kept when the sandbox is removed. The guest can reach its own and no other.
 */
export function historyDir(): string {
	return join(dataDir(), "history");
}

/**
 * Approved config graphs and their snapshots. Under the data directory, never
 * the project: the sandbox mounts only the project and its own
 * `history/<sandbox>`, so nothing inside a guest can reach these and approve
 * its own config.
 */
export function trustDir(): string {
	return join(dataDir(), "trust");
}

/**
 * The certificate authority the guest is baked to trust. Under the data
 * directory, never the project: the key must not be reachable from a guest,
 * which mounts only the project.
 */
export function caDir(): string {
	return join(dataDir(), "ca");
}

export function limaHome(): string {
	return process.env.LIMA_HOME ?? join(homedir(), ".lima");
}
