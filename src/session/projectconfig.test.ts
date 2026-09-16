import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	LEGACY_IGNORE_FILE,
	loadProjectConfig,
	validateMasks,
	validateSetup,
} from "./projectconfig.ts";

/**
 * The host must be able to import `.ts`, but this suite also runs on whatever
 * Node is inside a sandbox. The `.js` path exercises the same loader.
 */
const canImportTs = Boolean(
	(process.features as { typescript?: unknown }).typescript,
);

async function project(
	t: TestContext,
	files: Record<string, string> = {},
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "playpen-config-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	for (const [name, source] of Object.entries(files)) {
		await writeFile(join(dir, name), source, "utf8");
	}
	return dir;
}

test("keeps plain and nested relative paths", () => {
	const r = validateMasks(["node_modules", "packages/web/node_modules"]);
	assert.deepEqual(r.masked, ["node_modules", "packages/web/node_modules"]);
	assert.deepEqual(r.rejected, []);
});

test("rejects absolute paths, which are not project-relative", () => {
	const r = validateMasks(["/node_modules/"]);
	assert.deepEqual(r.masked, []);
	assert.deepEqual(r.rejected, ["/node_modules/"]);
});

test("rejects traversal out of the project", () => {
	const r = validateMasks(["../../etc", "a/../.."]);
	assert.deepEqual(r.masked, []);
	assert.deepEqual(r.rejected, ["../../etc", "a/../.."]);
});

test("rejects globs, which cannot be bind-mounted", () => {
	const r = validateMasks(["build/*"]);
	assert.deepEqual(r.masked, []);
	assert.deepEqual(r.rejected, ["build/*"]);
});

test("rejects empty entries and the project itself", () => {
	const r = validateMasks(["", "  ", ".", "./"]);
	assert.deepEqual(r.masked, []);
	assert.equal(r.rejected.length, 4);
});

test("rejects non-strings rather than coercing them", () => {
	const r = validateMasks([42, null, "node_modules"]);
	assert.deepEqual(r.masked, ["node_modules"]);
	assert.deepEqual(r.rejected, ["42", "null"]);
});

test("strips trailing slashes and dot segments", () => {
	assert.deepEqual(validateMasks(["target/", "./dist"]).masked, [
		"target",
		"dist",
	]);
});

test("absent config yields no masks", async (t) => {
	const r = await loadProjectConfig(await project(t));
	assert.deepEqual(r.masked, []);
	assert.equal(r.error, undefined);
	assert.equal(r.legacyIgnore, false);
});

test("reads masked from a default export", async (t) => {
	const dir = await project(t, {
		"playpen.config.js":
			'export default { masked: ["node_modules", "target"] };',
	});
	const r = await loadProjectConfig(dir);
	assert.deepEqual(r.masked, ["node_modules", "target"]);
	assert.equal(r.error, undefined);
});

test("validates entries coming out of the config", async (t) => {
	const dir = await project(t, {
		"playpen.config.js":
			'export default { masked: ["node_modules", "../etc"] };',
	});
	const r = await loadProjectConfig(dir);
	assert.deepEqual(r.masked, ["node_modules"]);
	assert.deepEqual(r.rejected, ["../etc"]);
});

test("a config with no masked key is not an error", async (t) => {
	const dir = await project(t, { "playpen.config.js": "export default {};" });
	const r = await loadProjectConfig(dir);
	assert.deepEqual(r.masked, []);
	assert.equal(r.error, undefined);
});

test("reports a missing default export by the file's own name", async (t) => {
	const dir = await project(t, {
		"playpen.config.js": 'export const masked = ["node_modules"];',
	});
	const r = await loadProjectConfig(dir);
	assert.equal(r.error, "playpen.config.js has no default export");
	assert.deepEqual(r.masked, []);
});

test("reports a non-object default export instead of throwing", async (t) => {
	const dir = await project(t, { "playpen.config.js": "export default 42;" });
	const r = await loadProjectConfig(dir);
	assert.match(r.error ?? "", /must default-export an object/);
});

test("reports a non-array masked instead of throwing", async (t) => {
	const dir = await project(t, {
		"playpen.config.js": 'export default { masked: "node_modules" };',
	});
	const r = await loadProjectConfig(dir);
	assert.match(r.error ?? "", /must be an array/);
});

test("a config that throws is reported, not propagated", async (t) => {
	const dir = await project(t, {
		"playpen.config.js": 'throw new Error("boom");',
	});
	const r = await loadProjectConfig(dir);
	assert.match(r.error ?? "", /boom/);
	assert.deepEqual(r.masked, []);
});

test("prefers playpen.config.ts when both files exist", {
	skip: !canImportTs,
}, async (t) => {
	const dir = await project(t, {
		"playpen.config.ts": 'export default { masked: ["from-ts"] };',
		"playpen.config.js": 'export default { masked: ["from-js"] };',
	});
	const r = await loadProjectConfig(dir);
	assert.deepEqual(r.masked, ["from-ts"]);
});

test("flags a leftover .playpenignore without reading it", async (t) => {
	const dir = await project(t, {
		"playpen.config.js": 'export default { masked: ["node_modules"] };',
		[LEGACY_IGNORE_FILE]: "target\n",
	});
	const r = await loadProjectConfig(dir);
	assert.equal(r.legacyIgnore, true);
	assert.deepEqual(r.masked, ["node_modules"]);
});

test("loads a TypeScript config", { skip: !canImportTs }, async (t) => {
	const dir = await project(t, {
		"playpen.config.ts":
			'export default { masked: ["node_modules"] satisfies string[] };',
	});
	const r = await loadProjectConfig(dir);
	assert.deepEqual(r.masked, ["node_modules"]);
});

test("keeps setup commands in order, trimmed", () => {
	const r = validateSetup(["npm ci", "  npm run build  "]);
	assert.deepEqual(r.setup, ["npm ci", "npm run build"]);
	assert.deepEqual(r.rejected, []);
});

test("rejects empty and non-string setup entries", () => {
	const r = validateSetup(["", "   ", 42, null, "npm ci"]);
	assert.deepEqual(r.setup, ["npm ci"]);
	assert.deepEqual(r.rejected, ["", "   ", "42", "null"]);
});

test("reads setup from a default export", async (t) => {
	const dir = await project(t, {
		"playpen.config.js": 'export default { setup: ["npm ci"] };',
	});
	const r = await loadProjectConfig(dir);
	assert.deepEqual(r.setup, ["npm ci"]);
	assert.equal(r.error, undefined);
});

test("masked and setup are independent, so either alone is enough", async (t) => {
	const masksOnly = await loadProjectConfig(
		await project(t, {
			"playpen.config.js": 'export default { masked: ["node_modules"] };',
		}),
	);
	assert.deepEqual(masksOnly.masked, ["node_modules"]);
	assert.deepEqual(masksOnly.setup, []);

	const setupOnly = await loadProjectConfig(
		await project(t, {
			"playpen.config.js": 'export default { setup: ["npm ci"] };',
		}),
	);
	assert.deepEqual(setupOnly.masked, []);
	assert.deepEqual(setupOnly.setup, ["npm ci"]);
});

test("reports a non-array setup instead of throwing", async (t) => {
	const dir = await project(t, {
		"playpen.config.js": 'export default { setup: "npm ci" };',
	});
	const r = await loadProjectConfig(dir);
	assert.match(r.error ?? "", /`setup` must be an array/);
});

test("an invalid setup entry is dropped, not fatal", async (t) => {
	const dir = await project(t, {
		"playpen.config.js": 'export default { setup: ["npm ci", ""] };',
	});
	const r = await loadProjectConfig(dir);
	assert.deepEqual(r.setup, ["npm ci"]);
	assert.deepEqual(r.rejectedSetup, [""]);
	assert.equal(r.error, undefined);
});
