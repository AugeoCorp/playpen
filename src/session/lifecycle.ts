import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaults, templatesDir } from "../config.ts";
import { baseImage } from "../image/base.ts";
import { render, serialize, type Rendered } from "../image/render.ts";
import * as lima from "../lima/client.ts";
import { instanceName, sandboxName } from "./identity.ts";
import { CONFIG_FILE, LEGACY_IGNORE_FILE } from "./projectconfig.ts";
import { loadTrustedConfig } from "./trust.ts";
import { checkMount } from "./mountguard.ts";
import * as store from "./store.ts";

export interface Sandbox {
  sandbox: string;
  instance: string;
  cwd: string;
}

/**
 * Keyed on the real path: on Fedora-derived hosts /home/<user> is a symlink to
 * /var/home/<user>, and the two spellings must not yield two sandboxes.
 */
export async function identify(cwd: string): Promise<Sandbox> {
  const real = await realpath(cwd);
  const sandbox = sandboxName(real);
  return { sandbox, instance: instanceName(sandbox), cwd: real };
}

function templatePath(sb: Sandbox): string {
  return join(templatesDir(), `${sb.sandbox}.yaml`);
}

function renderFor(sb: Sandbox, masks: string[]): Rendered {
  return render(baseImage, { ...defaults, mount: sb.cwd, masks });
}

async function loadMasks(sb: Sandbox): Promise<string[]> {
  const { masked, rejected, error, legacyIgnore } = await loadTrustedConfig(sb.cwd, sb.sandbox);
  if (error) {
    console.error(`warning: ${CONFIG_FILE} not loaded (${error})`);
    console.error(`  continuing with no masks; everything is shared over 9p.`);
  }
  if (legacyIgnore) {
    console.error(`warning: ${LEGACY_IGNORE_FILE} is no longer read. Move its entries to`);
    console.error(`  ${CONFIG_FILE}: export default { masked: ["node_modules"] }`);
  }
  for (const bad of rejected) {
    console.error(`warning: ignoring invalid \`masked\` entry: ${bad}`);
  }
  if (masked.length > 0) {
    console.error(`masking with guest-local storage: ${masked.join(", ")}`);
  }
  return masked;
}

async function writeTemplate(sb: Sandbox): Promise<{ path: string; hash: string }> {
  const rendered = renderFor(sb, await loadMasks(sb));
  await mkdir(templatesDir(), { recursive: true });
  // .yaml extension with JSON content: JSON is valid YAML, and Lima keys off the extension.
  const path = templatePath(sb);
  await writeFile(path, serialize(rendered) + "\n", "utf8");
  return { path, hash: rendered.contentHash };
}

/**
 * Lima boots an existing instance from its own stored lima.yaml, so edits to
 * the image definition or the project config silently do not reach it.
 * Comparing against the template written at creation catches both.
 */
async function warnIfStale(sb: Sandbox): Promise<void> {
  let previous: string;
  try {
    previous = await readFile(templatePath(sb), "utf8");
  } catch {
    return;
  }

  const current = serialize(renderFor(sb, await loadMasks(sb))) + "\n";
  if (current !== previous) {
    console.error(`warning: the image or ${CONFIG_FILE} changed since this sandbox was created.`);
    console.error(`  it is still running the old configuration.`);
    console.error(`  rebuild with: playpen rm --yes && playpen up`);
  }
}

export async function ensureRunning(sb: Sandbox): Promise<{ created: boolean }> {
  const existing = await lima.get(sb.instance);

  if (existing) {
    await warnIfStale(sb);
    if (!lima.isRunning(existing)) await lima.start(sb.instance);
    await store.touch(sb.sandbox);
    return { created: false };
  }

  // Only checked on creation: the mount is baked into the template then, and
  // re-checking on every start would nag about a decision already made.
  const guard = await checkMount(sb.cwd);
  if (!guard.ok) throw new Error(guard.reason ?? `refusing to mount ${sb.cwd}`);
  if (guard.warning) console.error(`warning: ${guard.warning}`);

  const { path, hash } = await writeTemplate(sb);
  await lima.createAndStart(sb.instance, path);

  const now = new Date().toISOString();
  await store.save({ name: sb.sandbox, cwd: sb.cwd, created: now, lastUsed: now, imageHash: hash });
  return { created: true };
}

export async function stop(sb: Sandbox): Promise<void> {
  const existing = await lima.get(sb.instance);
  if (existing && lima.isRunning(existing)) await lima.stop(sb.instance);
}

export async function destroy(sb: Sandbox): Promise<void> {
  const existing = await lima.get(sb.instance);
  if (existing) {
    if (lima.isRunning(existing)) await lima.stop(sb.instance, true);
    await lima.remove(sb.instance);
  }
  await store.remove(sb.sandbox);
}
