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
   * Masked, not hidden: the host directory stays mounted underneath, and the
   * guest has passwordless root and can unmount the mask. This is a speed and
   * correctness feature. Keep secrets outside the project directory.
   *
   * One concrete relative path per entry; a bind mount needs a single target,
   * so globs are unsupported.
   */
  masked?: string[];
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
  /** Entries dropped by validation, verbatim, for warning about. */
  rejected: string[];
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

    if (clean === "" || clean === "." || clean.startsWith("..") || entry.startsWith("/")) {
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

export async function hasLegacyIgnore(projectDir: string): Promise<boolean> {
  return exists(join(projectDir, LEGACY_IGNORE_FILE));
}

/** The config filename present in the project, or null. */
export async function findConfigFile(projectDir: string): Promise<string | null> {
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
  const empty: LoadedConfig = { masked: [], rejected: [] };

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

  const masked = (config as PlaypenConfig).masked;
  if (masked === undefined) return empty;
  if (!Array.isArray(masked)) {
    return { ...empty, error: `${name}: \`masked\` must be an array of strings` };
  }

  return validateMasks(masked);
}

/** Ungated: executes the project's config in place. See `importConfig`. */
export async function loadProjectConfig(projectDir: string): Promise<ConfigResult> {
  const legacyIgnore = await hasLegacyIgnore(projectDir);
  const name = await findConfigFile(projectDir);
  if (name === null) return { masked: [], rejected: [], legacyIgnore };
  return { ...(await importConfig(join(projectDir, name))), legacyIgnore };
}
