import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

export const INSTANCE_PREFIX = "playpen-";

/**
 * The basename keeps it recognizable; the path hash keeps two projects with the
 * same directory name distinct. Same directory, same name, which is what makes
 * `playpen up` reattach instead of creating a second VM.
 */
export function sandboxName(cwd: string): string {
  const abs = resolve(cwd);
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 6);
  const slug =
    basename(abs)
      .toLowerCase()
      // Lima instance names allow only alphanumerics and dashes.
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "project";
  return `${slug}-${hash}`;
}

/** Prefixed so playpen never touches foreign instances. */
export function instanceName(sandbox: string): string {
  return `${INSTANCE_PREFIX}${sandbox}`;
}

export function isPlaypenInstance(name: string): boolean {
  return name.startsWith(INSTANCE_PREFIX);
}

export function sandboxFromInstance(name: string): string {
  return name.slice(INSTANCE_PREFIX.length);
}
