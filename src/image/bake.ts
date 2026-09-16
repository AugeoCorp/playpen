import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaults, templatesDir } from "../config.ts";
import * as lima from "../lima/client.ts";
import { baseInstanceName, parseBaseInstance } from "../session/identity.ts";
import { baseImage } from "./base.ts";
import { imageHash, renderBase, serialize } from "./render.ts";

/** Identifies the image definition every sandbox clones from. */
export function currentHash(): string {
  return imageHash(baseImage);
}

/**
 * The build date is outside the hash, so one definition can have several bases.
 * The newest has the freshest packages, so it wins.
 */
export function pickBase(names: readonly string[], hash: string): string | null {
  const matches = names.flatMap((name) => {
    const parsed = parseBaseInstance(name);
    return parsed && parsed.hash === hash ? [{ name, date: parsed.date }] : [];
  });
  matches.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return matches[0]?.name ?? null;
}

export async function findBase(hash = currentHash()): Promise<string | null> {
  return pickBase(
    (await lima.list()).map((i) => i.name),
    hash,
  );
}

/** UTC, so two hosts in different timezones label the same bake the same way. */
function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function buildBase(now = new Date()): Promise<string> {
  const name = baseInstanceName(currentHash(), isoDate(now));
  const rendered = renderBase(baseImage, defaults);

  await mkdir(templatesDir(), { recursive: true });
  const path = join(templatesDir(), `${name}.yaml`);
  await writeFile(path, serialize(rendered) + "\n", "utf8");

  await lima.createAndStart(name, path);
  // `limactl clone` refuses a running source, so a base stops for good once it
  // is baked.
  await lima.stop(name);
  return name;
}

export async function ensureBase(): Promise<{ instance: string; built: boolean }> {
  const instances = await lima.list();
  const found = pickBase(
    instances.map((i) => i.name),
    currentHash(),
  );
  if (!found) return { instance: await buildBase(), built: true };

  // A base should never be running, but a stray `limactl start` should not
  // leave `up` unable to clone.
  if (lima.isRunning(instances.find((i) => i.name === found) ?? null)) await lima.stop(found);
  return { instance: found, built: false };
}
