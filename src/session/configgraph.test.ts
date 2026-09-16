import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { findSpecifiers, readConfigGraph } from "./configgraph.ts";

async function project(t: TestContext, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "playpen-graph-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), contents, "utf8");
  }
  return dir;
}

test("finds every form of static import and require", () => {
  const source = [
    'import a from "./a.js";',
    "import { b } from './b.js';",
    'import "./side.js";',
    'export { c } from "./c.js";',
    'export * from "./d.js";',
    'const e = await import("./e.js");',
    'const f = require("./f.js");',
  ].join("\n");
  assert.deepEqual(findSpecifiers(source), [
    "./a.js",
    "./b.js",
    "./side.js",
    "./c.js",
    "./d.js",
    "./e.js",
    "./f.js",
  ]);
});

test("type-only imports load nothing, so they are not part of the graph", () => {
  const source = [
    'import type { T } from "./types.ts";',
    'export type { U } from "./more-types.ts";',
    'import { type V, w } from "./mixed.ts";',
  ].join("\n");
  assert.deepEqual(findSpecifiers(source), ["./mixed.ts"]);
});

test("a config with no imports is a graph of one file", async (t) => {
  const dir = await project(t, { "playpen.config.js": "export default { masked: [] };" });
  const graph = await readConfigGraph(dir, "playpen.config.js");
  assert.deepEqual(
    graph.files.map((f) => f.rel),
    ["playpen.config.js"],
  );
});

test("follows relative imports through nested directories, transitively", async (t) => {
  const dir = await project(t, {
    "playpen.config.js": 'import { m } from "./config/masks.js"; export default { masked: m };',
    "config/masks.js": 'import { base } from "../lib/base.js"; export const m = base;',
    "lib/base.js": 'export const base = ["node_modules"];',
  });
  const graph = await readConfigGraph(dir, "playpen.config.js");
  assert.deepEqual(
    graph.files.map((f) => f.rel),
    ["config/masks.js", "lib/base.js", "playpen.config.js"],
  );
});

test("builtin modules are not part of the graph", async (t) => {
  const dir = await project(t, {
    "playpen.config.js": 'import { join } from "node:path"; import fs from "fs"; export default {};',
  });
  const graph = await readConfigGraph(dir, "playpen.config.js");
  assert.equal(graph.files.length, 1);
});

test("an import that does not exist is left for Node to report", async (t) => {
  const dir = await project(t, {
    "playpen.config.js": 'import "./missing.js"; export default {};',
  });
  const graph = await readConfigGraph(dir, "playpen.config.js");
  assert.equal(graph.files.length, 1);
});

test("refuses an import that reaches outside the project", async (t) => {
  const dir = await project(t, {
    "playpen.config.js": 'import "../outside.js"; export default {};',
  });
  await assert.rejects(() => readConfigGraph(dir, "playpen.config.js"), /outside the project/);
});

test("refuses a package import, which cannot be pinned", async (t) => {
  const dir = await project(t, {
    "playpen.config.js": 'import { z } from "zod"; export default {};',
  });
  await assert.rejects(() => readConfigGraph(dir, "playpen.config.js"), /a package/);
});

test("the graph hash changes when an imported file changes", async (t) => {
  const dir = await project(t, {
    "playpen.config.js": 'import { m } from "./masks.js"; export default { masked: m };',
    "masks.js": 'export const m = ["node_modules"];',
  });
  const before = await readConfigGraph(dir, "playpen.config.js");
  await writeFile(join(dir, "masks.js"), 'export const m = ["node_modules", "dist"];', "utf8");
  const after = await readConfigGraph(dir, "playpen.config.js");
  assert.notEqual(after.hash, before.hash);
});

test("the graph hash is stable across reads of unchanged files", async (t) => {
  const dir = await project(t, {
    "playpen.config.js": 'import { m } from "./masks.js"; export default { masked: m };',
    "masks.js": 'export const m = ["node_modules"];',
  });
  const first = await readConfigGraph(dir, "playpen.config.js");
  const second = await readConfigGraph(dir, "playpen.config.js");
  assert.equal(second.hash, first.hash);
});

test("a query string on a specifier does not hide the file", async (t) => {
  const dir = await project(t, {
    "playpen.config.js": 'import "./masks.js?v=2"; export default {};',
    "masks.js": "export const m = [];",
  });
  const graph = await readConfigGraph(dir, "playpen.config.js");
  assert.deepEqual(
    graph.files.map((f) => f.rel),
    ["masks.js", "playpen.config.js"],
  );
});
