import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { historyDir } from "../config.ts";
import * as lima from "../lima/client.ts";

/**
 * Claude Code keeps session transcripts and the persistent memory directory in
 * the guest, and nothing syncs them back to the host, so recloning a sandbox
 * would drop both. They are archived out before a sandbox is destroyed and
 * restored into its replacement.
 *
 * The whole directory travels rather than one project's slug: a sandbox serves
 * a single project, so that is already the scope, and it avoids depending on
 * how Claude Code names these directories.
 */
const GUEST_REL = ".claude/projects";

/** Joined into a path that is written and read, so it is checked like `store`'s. */
export function archivePath(sandbox: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(sandbox)) {
    throw new Error(`invalid sandbox name: ${JSON.stringify(sandbox)}`);
  }
  return join(historyDir(), `${sandbox}.tar`);
}

/** Never throws: losing history is bad, but blocking a delete over it is worse. */
export async function archive(instance: string, sandbox: string): Promise<void> {
  // Succeeds with no output when there is nothing to archive, rather than
  // signalling it through an exit code limactl may not pass back.
  const script = [
    "set -eu",
    'cd "$HOME"',
    `if [ -d ${GUEST_REL} ]; then exec tar -cf - ${GUEST_REL}; fi`,
  ].join("\n");

  try {
    const result = await lima.runScript(instance, script);
    if (result.code === 0 && result.stdout.length === 0) return;
    if (result.code !== 0) {
      console.error(`warning: could not save Claude history (${result.stderr.trim() || `exit ${result.code}`})`);
      return;
    }
    await mkdir(historyDir(), { recursive: true });
    await writeFile(archivePath(sandbox), result.stdout);
  } catch (err) {
    console.error(`warning: could not save Claude history (${err instanceof Error ? err.message : err})`);
  }
}

/** Kept after restoring, so it stays the last known history if this one is lost. */
export async function restore(instance: string, sandbox: string): Promise<boolean> {
  let tar: Buffer;
  try {
    tar = await readFile(archivePath(sandbox));
  } catch {
    return false;
  }

  const script = ["set -eu", "umask 077", 'cd "$HOME"', "tar -xf -"].join("\n");
  const result = await lima.runScript(instance, script, { input: tar });
  if (result.code !== 0) {
    console.error(`warning: could not restore Claude history (${result.stderr.trim()})`);
    return false;
  }
  return true;
}
