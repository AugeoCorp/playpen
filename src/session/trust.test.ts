import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { trustDir } from "../config.ts";
import { readConfigGraph } from "./configgraph.ts";
import {
	decideTrust,
	loadTrustedConfig,
	pinConfig,
	previewApproval,
} from "./trust.ts";

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
	const previous = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = data;
	t.after(async () => {
		if (previous === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previous;
		await rm(dir, { recursive: true, force: true });
		await rm(data, { recursive: true, force: true });
	});
	for (const [rel, contents] of Object.entries(files)) {
		await writeFile(join(dir, rel), contents, "utf8");
	}
	return { dir, sandbox: `trust-case-${++counter}` };
}

/** Stand in for the operator answering "y" at the prompt. */
async function approve(
	dir: string,
	sandbox: string,
	file = "playpen.config.js",
): Promise<void> {
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
	await writeFile(
		join(dir, "playpen.config.js"),
		`${CONFIG} // and something else\n`,
		"utf8",
	);

	const r = await loadTrustedConfig(dir, sandbox);
	assert.equal(r.state, "changed");
	assert.equal(r.loaded, false);
	assert.deepEqual(r.masked, []);
});

test("editing a file the approved config imports revokes it too", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js":
			'import { m } from "./masks.js"; export default { masked: m };',
		"masks.js": 'export const m = ["node_modules"];',
	});
	await approve(dir, sandbox);
	await writeFile(
		join(dir, "masks.js"),
		'console.log("ran on host"); export const m = [];',
		"utf8",
	);

	const r = await loadTrustedConfig(dir, sandbox);
	assert.equal(r.state, "changed");
	assert.equal(r.loaded, false);
});

test("an approved config that imports a project file is executed with it", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js":
			'import { m } from "./masks.js"; export default { masked: m };',
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

test("an approval recorded without the date it was approved is asked for again, even though its hash matches", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await approve(dir, sandbox);
	const record = join(trustDir(), `${sandbox}.json`);
	const { hash, file, files } = JSON.parse(await readFile(record, "utf8"));
	await writeFile(record, JSON.stringify({ hash, file, files }), "utf8");

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
	await assert.rejects(
		() => pinConfig("../../etc/passwd", graph),
		/invalid sandbox name/,
	);
});

/** What the approval prompt would print for the project as it is now. */
async function promptFor(dir: string, sandbox: string): Promise<string> {
	return previewApproval(
		sandbox,
		await readConfigGraph(dir, "playpen.config.js"),
	);
}

const ESC = "\x1b";

test("the prompt shows an escape sequence in a config as text, so it cannot redraw the screen", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": `run();${ESC}[2K${ESC}[1Ashown();`,
	});
	const shown = await promptFor(dir, sandbox);
	assert.ok(!shown.includes(ESC), `a raw ESC reached the terminal: ${shown}`);
	assert.match(shown, /│ run\(\);\\x1b\[2K\\x1b\[1Ashown\(\);$/m);
});

test("the prompt shows a carriage return as \\r, so a line cannot be overwritten from its start", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": "run();\r// harmless",
	});
	const shown = await promptFor(dir, sandbox);
	assert.ok(!shown.includes("\r"), `a raw CR reached the terminal: ${shown}`);
	assert.match(shown, /│ run\(\);\\r\/\/ harmless$/m);
});

test("the prompt shows a right-to-left override as \\u202e, so the line reads in the order it runs", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": 'const role = "user\u202e // admin";',
	});
	const shown = await promptFor(dir, sandbox);
	assert.ok(
		!shown.includes("\u202e"),
		`a raw U+202E reached the terminal: ${shown}`,
	);
	assert.match(shown, /│ const role = "user\\u202e \/\/ admin";$/m);
});

test("the prompt shows the one-character C1 control sequence introducer as \\u009b", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": "run();\u009b2K",
	});
	const shown = await promptFor(dir, sandbox);
	assert.ok(
		!shown.includes("\u009b"),
		`a raw U+009B reached the terminal: ${shown}`,
	);
	assert.match(shown, /│ run\(\);\\u009b2K$/m);
});

test("the prompt ends with a warning naming only the files that held control characters", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js":
			'import "./clean.js"; import "./tricky.js"; export default {};',
		"clean.js": "export const a = 1;",
		"tricky.js": `export const b = 1;${ESC}[8m`,
	});
	assert.match(
		await promptFor(dir, sandbox),
		/\n\n {2}warning: control characters, [^\n]* in: tricky\.js$/,
	);
});

test("the prompt shows ordinary code exactly as written, tabs and non-ASCII letters included, with no warning", async (t) => {
	const code = 'export default {\n\tmasked: ["café", "漢字"],\n};';
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": code });
	assert.equal(
		await promptFor(dir, sandbox),
		[
			"  ── playpen.config.js (new)",
			"  │ export default {",
			'  │ \tmasked: ["café", "漢字"],',
			"  │ };",
		].join("\n"),
	);
});

test("the prompt escapes a file name, and names that file in its warning", async (t) => {
	const tricky = `${ESC}[8mhidden.js`;
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": `import "./${tricky}"; export default {};`,
		[tricky]: "export {};",
	});
	const shown = await promptFor(dir, sandbox);
	assert.ok(!shown.includes(ESC), `a raw ESC reached the terminal: ${shown}`);
	assert.match(shown, /^ {2}── \\x1b\[8mhidden\.js \(new\)$/m);
	assert.match(
		shown,
		/warning: .* in: \\x1b\[8mhidden\.js, playpen\.config\.js$/m,
	);
});

test("the prompt escapes the name of a file whose contents it does not show", async (t) => {
	const tricky = `${ESC}[8mhidden.js`;
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": `import "./${tricky}"; export default {};`,
		[tricky]: "export {};",
	});
	await approve(dir, sandbox);
	await writeFile(
		join(dir, "playpen.config.js"),
		`import "./${tricky}"; export default { masked: [] };`,
		"utf8",
	);
	const shown = await promptFor(dir, sandbox);
	assert.match(shown, /^ {2}── \\x1b\[8mhidden\.js \(unchanged\)$/m);
	assert.ok(!shown.includes(ESC), `a raw ESC reached the terminal: ${shown}`);
});

/** Approve the project as it is, and load it once so the approved copy is kept. */
async function approveAndLoad(dir: string, sandbox: string): Promise<void> {
	await approve(dir, sandbox);
	assert.equal((await loadTrustedConfig(dir, sandbox)).loaded, true);
}

const NETWORKED = [
	"export default {",
	'\tmasked: ["node_modules"],',
	'\tsetup: ["npm ci"],',
	"\tnetwork: {",
	'\t\tallow: ["registry.npmjs.org"],',
	"\t},",
	"};",
	"",
].join("\n");

test("a changed file is shown as a diff against the approved version, not whole", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": NETWORKED,
	});
	await approveAndLoad(dir, sandbox);
	await writeFile(
		join(dir, "playpen.config.js"),
		NETWORKED.replace("registry.npmjs.org", "evil.example"),
		"utf8",
	);
	assert.equal(
		await promptFor(dir, sandbox),
		[
			"  ── playpen.config.js (changed)",
			"  │ @@ -2,6 +2,6 @@",
			'  │  \tmasked: ["node_modules"],',
			'  │  \tsetup: ["npm ci"],',
			"  │  \tnetwork: {",
			'  │ -\t\tallow: ["registry.npmjs.org"],',
			'  │ +\t\tallow: ["evil.example"],',
			"  │  \t},",
			"  │  };",
		].join("\n"),
	);
});

test("the diff is of the bytes that were hashed, not of the file as it is on disk by the time it is shown", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await approveAndLoad(dir, sandbox);
	await writeFile(join(dir, "playpen.config.js"), "hashed();", "utf8");
	const graph = await readConfigGraph(dir, "playpen.config.js");
	await writeFile(join(dir, "playpen.config.js"), "swapped();", "utf8");

	const shown = await previewApproval(sandbox, graph);
	assert.match(shown, /│ \+hashed\(\);$/m);
	assert.doesNotMatch(shown, /swapped/);
});

test("a file the config no longer imports is named as removed", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js":
			'import { m } from "./masks.js"; export default { masked: m };',
		"masks.js": 'export const m = ["node_modules"];',
	});
	await approveAndLoad(dir, sandbox);
	await writeFile(join(dir, "playpen.config.js"), CONFIG, "utf8");
	assert.match(
		await promptFor(dir, sandbox),
		/^ {2}── masks\.js \(removed\)$/m,
	);
});

test("a changed file whose approved copy does not match its approved hash is shown whole, saying why", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await approveAndLoad(dir, sandbox);
	await writeFile(
		join(trustDir(), sandbox, "playpen.config.js"),
		"export default {};",
		"utf8",
	);
	await writeFile(join(dir, "playpen.config.js"), "changed();", "utf8");
	assert.equal(
		await promptFor(dir, sandbox),
		[
			"  ── playpen.config.js (changed, shown whole: the approved copy does not match its hash)",
			"  │ changed();",
		].join("\n"),
	);
});

test("a changed file with no approved copy kept is shown whole, saying why", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await approve(dir, sandbox);
	await writeFile(join(dir, "playpen.config.js"), "changed();", "utf8");
	assert.equal(
		await promptFor(dir, sandbox),
		[
			"  ── playpen.config.js (changed, shown whole: no approved copy to compare with)",
			"  │ changed();",
		].join("\n"),
	);
});

test("a change to only the newline at the end of a file is named, since a line diff cannot show it", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await approveAndLoad(dir, sandbox);
	await writeFile(join(dir, "playpen.config.js"), `${CONFIG}\n`, "utf8");
	assert.equal(
		await promptFor(dir, sandbox),
		"  ── playpen.config.js (changed: only the newline at the end of the file)",
	);
});

test("an escape sequence inside a diffed line is still shown escaped, and warned about", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await approveAndLoad(dir, sandbox);
	await writeFile(join(dir, "playpen.config.js"), `${CONFIG}${ESC}[2K`, "utf8");
	const shown = await promptFor(dir, sandbox);
	assert.ok(!shown.includes(ESC), `a raw ESC reached the terminal: ${shown}`);
	assert.match(shown, /│ \+export default .*;\\x1b\[2K$/m);
	assert.match(shown, /warning: [^\n]* in: playpen\.config\.js$/);
});

test("with colour on, diff lines are coloured around their escaped text", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": "old();" });
	await approveAndLoad(dir, sandbox);
	await writeFile(join(dir, "playpen.config.js"), `new();${ESC}[2K`, "utf8");
	const graph = await readConfigGraph(dir, "playpen.config.js");
	assert.equal(
		await previewApproval(sandbox, graph, true),
		[
			"  ── playpen.config.js (changed)",
			`  │ ${ESC}[36m@@ -1,1 +1,1 @@${ESC}[0m`,
			`  │ ${ESC}[31m-old();${ESC}[0m`,
			`  │ ${ESC}[32m+new();\\x1b[2K${ESC}[0m`,
			"",
			"  warning: control characters, shown above as escapes like \\x1b or \\u202e, in: playpen.config.js",
		].join("\n"),
	);
});

test("with colour on, a file shown whole is not coloured, even where a line starts with - or +", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": "-1;\n+1;",
	});
	const graph = await readConfigGraph(dir, "playpen.config.js");
	assert.equal(
		await previewApproval(sandbox, graph, true),
		["  ── playpen.config.js (new)", "  │ -1;", "  │ +1;"].join("\n"),
	);
});
