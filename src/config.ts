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
  const xdg = process.env["XDG_DATA_HOME"];
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
 * Claude transcripts and memory saved out of a sandbox before it is destroyed.
 * Under the data directory for the same reason as `trustDir`: the guest can
 * reach only the project mount, so it cannot read or rewrite its own history.
 */
export function historyDir(): string {
  return join(dataDir(), "history");
}

/**
 * Approved config graphs and their snapshots. Under the data directory, never
 * the project: the sandbox mounts only the project, so nothing inside a guest
 * can reach these and approve its own config.
 */
export function trustDir(): string {
  return join(dataDir(), "trust");
}

export function limaHome(): string {
  return process.env["LIMA_HOME"] ?? join(homedir(), ".lima");
}
