import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readConfigGraph } from "./configgraph.ts";
import { decideTrust, loadTrustedConfig, pinConfig } from "./trust.ts";

test("no file on disk is 'absent', whatever is pinned", () => {
  assert.equal(decideTrust(null, null), "absent");
  assert.equal(decideTrust("abc", null), "absent");
});

test("a file with no pin is 'unpinned'", () => {
  assert.equal(decideTrust(null, "abc"), "unpinned");
});

test("a matching pin is 'trusted'", () => {
  assert.equal(decideTrust("abc", "abc"), "trusted");
});

test("a differing pin is 'changed'", () => {
  assert.equal(decideTrust("abc", "def"), "changed");
});

// node --test never runs against a TTY, so every case below exercises the
// fail-closed path: an unapproved config is not executed when nobody can be asked.

let counter = 0;

/** A project dir plus an isolated data dir, so pins never leak between tests. */
async function scenario(
  t: TestContext,
  files: Record<string, string>,
): Promise<{ dir: string; sandbox: string }> {
  const dir = await mkdtemp(join(tmpdir(), "playpen-trust-"));
  const data = await mkdtemp(join(tmpdir(), "playpen-data-"));
  const previous = process.env["XDG_DATA_HOME"];
  process.env["XDG_DATA_HOME"] = data;
  t.after(async () => {
    if (previous === undefined) delete process.env["XDG_DATA_HOME"];
    else process.env["XDG_DATA_HOME"] = previous;
    await rm(dir, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  });
  for (const [rel, contents] of Object.entries(files)) {
    await writeFile(join(dir, rel), contents, "utf8");
  }
  return { dir, sandbox: `trust-case-${++counter}` };
}

/** Stand in for the operator answering "y" at the prompt. */
async function approve(dir: string, sandbox: string, file = "playpen.config.js"): Promise<void> {
  await pinConfig(sandbox, await readConfigGraph(dir, file));
}

const CONFIG = 'export default { masked: ["node_modules"] };';

test("a project with no config needs no approval", async (t) => {
  const { dir, sandbox } = await scenario(t, {});
  const r = await loadTrustedConfig(dir, sandbox);
  assert.equal(r.state, "absent");
  assert.equal(r.loaded, false);
  assert.deepEqual(r.masked, []);
});

test("an approved config is executed without asking", async (t) => {
  const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
  await approve(dir, sandbox);

  const r = await loadTrustedConfig(dir, sandbox);
  assert.equal(r.state, "trusted");
  assert.equal(r.loaded, true);
  assert.deepEqual(r.masked, ["node_modules"]);
});

test("an unapproved config is not executed without a terminal", async (t) => {
  const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
  const r = await loadTrustedConfig(dir, sandbox);
  assert.equal(r.state, "unpinned");
  assert.equal(r.loaded, false);
  assert.deepEqual(r.masked, []);
});

test("editing an approved config revokes it", async (t) => {
  const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
  await approve(dir, sandbox);
  await writeFile(join(dir, "playpen.config.js"), `${CONFIG} // and something else\n`, "utf8");

  const r = await loadTrustedConfig(dir, sandbox);
  assert.equal(r.state, "changed");
  assert.equal(r.loaded, false);
  assert.deepEqual(r.masked, []);
});

test("editing a file the approved config imports revokes it too", async (t) => {
  const { dir, sandbox } = await scenario(t, {
    "playpen.config.js": 'import { m } from "./masks.js"; export default { masked: m };',
    "masks.js": 'export const m = ["node_modules"];',
  });
  await approve(dir, sandbox);
  await writeFile(join(dir, "masks.js"), 'console.log("ran on host"); export const m = [];', "utf8");

  const r = await loadTrustedConfig(dir, sandbox);
  assert.equal(r.state, "changed");
  assert.equal(r.loaded, false);
});

test("an approved config that imports a project file is executed with it", async (t) => {
  const { dir, sandbox } = await scenario(t, {
    "playpen.config.js": 'import { m } from "./masks.js"; export default { masked: m };',
    "masks.js": 'export const m = ["node_modules", "dist"];',
  });
  await approve(dir, sandbox);

  const r = await loadTrustedConfig(dir, sandbox);
  assert.equal(r.state, "trusted");
  assert.deepEqual(r.masked, ["node_modules", "dist"]);
});

test("a config whose imports cannot be pinned is reported and not executed", async (t) => {
  const { dir, sandbox } = await scenario(t, {
    "playpen.config.js": 'import "../elsewhere.js"; export default {};',
  });
  const r = await loadTrustedConfig(dir, sandbox);
  assert.equal(r.loaded, false);
  assert.match(r.error ?? "", /outside the project/);
});

test("approving one filename does not bless another", async (t) => {
  const { dir, sandbox } = await scenario(t, {
    "playpen.config.ts": CONFIG,
    "playpen.config.js": CONFIG,
  });
  await approve(dir, sandbox, "playpen.config.js");
  await rm(join(dir, "playpen.config.js"));
  await writeFile(join(dir, "playpen.config.js"), CONFIG, "utf8");

  // Same bytes are approved under the .js name, but .ts is what will be loaded.
  const r = await loadTrustedConfig(dir, sandbox);
  assert.equal(r.state, "unpinned");
  assert.equal(r.loaded, false);
});

test("a pin is scoped to its sandbox", async (t) => {
  const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
  await approve(dir, sandbox);

  const r = await loadTrustedConfig(dir, `${sandbox}-other`);
  assert.equal(r.state, "unpinned");
  assert.equal(r.loaded, false);
});

test("a leftover .playpenignore is reported even when nothing is executed", async (t) => {
  const { dir, sandbox } = await scenario(t, {
    "playpen.config.js": CONFIG,
    ".playpenignore": "target\n",
  });
  const r = await loadTrustedConfig(dir, sandbox);
  assert.equal(r.legacyIgnore, true);
});

test("rejects a sandbox name that would escape the trust directory", async (t) => {
  const { dir } = await scenario(t, { "playpen.config.js": CONFIG });
  const graph = await readConfigGraph(dir, "playpen.config.js");
  await assert.rejects(() => pinConfig("../../etc/passwd", graph), /invalid sandbox name/);
});
