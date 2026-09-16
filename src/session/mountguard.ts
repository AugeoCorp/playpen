import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
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
  return { home, protectedDirs: [dataDir(), limaHome(), join(home, ".claude")] };
}

const SYSTEM_DIRS = ["/etc", "/usr", "/var", "/boot", "/nix", "/tmp"];

function contains(parent: string, child: string): boolean {
  return child.startsWith(parent + "/");
}

/**
 * Refuse to mount directories where a writable mount would be reckless.
 *
 * The sandbox exists to keep an agent away from your host filesystem. Mounting
 * $HOME or / hands back everything it was meant to withhold, so those are hard
 * refusals rather than warnings.
 */
export async function checkMount(dir: string, env: GuardEnv = hostEnv()): Promise<GuardResult> {
  const abs = resolve(dir);
  const home = resolve(env.home);

  if (abs === parse(abs).root) {
    return { ok: false, reason: "refusing to mount the filesystem root" };
  }
  if (abs === home) {
    return {
      ok: false,
      reason:
        `refusing to mount your home directory (${home}) read-write into a sandbox. ` +
        `Run playpen from inside a project instead.`,
    };
  }
  if (contains(abs, home)) {
    return { ok: false, reason: `refusing to mount ${abs}: it contains your home directory` };
  }
  if (SYSTEM_DIRS.includes(abs)) {
    return { ok: false, reason: `refusing to mount system directory ${abs}` };
  }

  for (const guarded of env.protectedDirs.map((p) => resolve(p))) {
    if (abs === guarded || contains(abs, guarded)) {
      return {
        ok: false,
        reason: `refusing to mount ${abs}: it contains ${guarded}, which the sandbox must not be able to write`,
      };
    }
    if (contains(guarded, abs)) {
      return {
        ok: false,
        reason: `refusing to mount ${abs}: it is inside ${guarded}, which the sandbox must not be able to write`,
      };
    }
  }

  if (!(await exists(join(abs, ".git")))) {
    return {
      ok: true,
      warning: `${abs} is not a git repository — an agent's changes here are not recoverable via git`,
    };
  }
  return { ok: true };
}
