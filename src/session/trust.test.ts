import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { type TestContext, test } from "node:test";
import { trustDir } from "../config.ts";
import { readConfigGraph } from "./configgraph.ts";
import {
	approveMounts,
	decideTrust,
	escapeUnshowable,
	loadTrustedConfig,
	pinConfig,
	pinMounts,
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

// Every case below runs with no terminal, so it exercises the fail-closed
// path: an unapproved config is not executed when nobody can be asked.

let counter = 0;

/** A project dir plus an isolated data dir, so pins never leak between tests. */
async function scenario(
	t: TestContext,
	files: Record<string, string>,
): Promise<{ dir: string; sandbox: string }> {
	const dir = await mkdtemp(join(tmpdir(), "playpen-trust-"));
	const data = await mkdtemp(join(tmpdir(), "playpen-data-"));
	const previous = process.env.XDG_DATA_HOME;
	const tty = process.stdin.isTTY;
	process.env.XDG_DATA_HOME = data;
	process.stdin.isTTY = false;
	t.after(async () => {
		process.stdin.isTTY = tty;
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
	assert.equal(r.error, undefined);
	assert.deepEqual(r.masked, []);
});

test("an approved config is executed without asking", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await approve(dir, sandbox);

	const r = await loadTrustedConfig(dir, sandbox);
	assert.equal(r.state, "trusted");
	assert.equal(r.error, undefined);
	assert.deepEqual(r.masked, ["node_modules"]);
});

test("an unapproved config is not executed without a terminal", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	const r = await loadTrustedConfig(dir, sandbox);
	assert.equal(r.state, "unpinned");
	assert.match(r.error ?? "", /approval needs a terminal/);
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
	assert.match(r.error ?? "", /approval needs a terminal/);
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
	assert.match(r.error ?? "", /approval needs a terminal/);
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
	assert.match(r.error ?? "", /approval needs a terminal/);
});

test("an approval recorded without the date it was approved is asked for again, even though its hash matches", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await approve(dir, sandbox);
	const record = join(trustDir(), `${sandbox}.json`);
	const { hash, file, files } = JSON.parse(await readFile(record, "utf8"));
	await writeFile(record, JSON.stringify({ hash, file, files }), "utf8");

	const r = await loadTrustedConfig(dir, sandbox);
	assert.equal(r.state, "unpinned");
	assert.match(r.error ?? "", /approval needs a terminal/);
});

test("a pin is scoped to its sandbox", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await approve(dir, sandbox);

	const r = await loadTrustedConfig(dir, `${sandbox}-other`);
	assert.equal(r.state, "unpinned");
	assert.match(r.error ?? "", /approval needs a terminal/);
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

/** Everything printed while `ask` waits at a terminal, where the answer is no. */
async function shownAtTerminal(
	t: TestContext,
	ask: () => Promise<unknown>,
): Promise<string> {
	const terminal = Object.assign(Readable.from(["n\n"]), { isTTY: true });
	t.mock.getter(process, "stdin", () => terminal);
	const said = t.mock.method(console, "error", () => {});
	await ask();
	return said.mock.calls.map((call) => String(call.arguments[0])).join("\n");
}

test("the prompt shows ordinary code exactly as written, tabs and non-ASCII letters included", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": 'export default {\n\tmasked: ["café", "漢字"],\n};\n',
	});
	const shown = await shownAtTerminal(t, () => loadTrustedConfig(dir, sandbox));
	assert.match(
		shown,
		/\n\n {2}── playpen\.config\.js \(new\)\n {2}│ \+ export default \{\n {2}│ \+ \tmasked: \["café", "漢字"\],\n {2}│ \+ \};\n$/,
	);
});

test("the prompt shows an escape sequence in a config as text, and warns that it did", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": "run();\x1b[2Kshown();",
	});
	const shown = await shownAtTerminal(t, () => loadTrustedConfig(dir, sandbox));
	assert.match(
		shown,
		/\n {2}│ \+ run\(\);\\u\{1b\}\[2Kshown\(\);\n\n {2}warning: invisible or control characters are shown above as escapes/,
	);
});

test("a newline in a file name is shown as an escape, so the name cannot pass for lines of the prompt", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": '/* import "./notes.js (new)\n  │ harmless();" */',
		"notes.js (new)\n  │ harmless();": "payload();",
	});
	const shown = await shownAtTerminal(t, () => loadTrustedConfig(dir, sandbox));
	assert.match(
		shown,
		/\n {2}── notes\.js \(new\)\\u\{a\} {2}│ harmless\(\); \(new\)\n {2}│ \+ payload\(\);\n/,
	);
});

test("a carriage return ends the line it is on, as it does for JavaScript, so the code after it is not shown as part of a comment", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": "// harmless note\rpayload();",
	});
	const shown = await shownAtTerminal(t, () => loadTrustedConfig(dir, sandbox));
	assert.match(
		shown,
		/\n {2}│ \+ \/\/ harmless note\\u\{d\}\n {2}│ \+ payload\(\);\n/,
	);
});

test("a line separator, U+2028, ends the line it is on", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": "// harmless note\u2028payload();",
	});
	const shown = await shownAtTerminal(t, () => loadTrustedConfig(dir, sandbox));
	assert.match(
		shown,
		/\n {2}│ \+ \/\/ harmless note\\u\{2028\}\n {2}│ \+ payload\(\);\n/,
	);
});

test("a paragraph separator, U+2029, ends the line it is on", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": "// harmless note\u2029payload();",
	});
	const shown = await shownAtTerminal(t, () => loadTrustedConfig(dir, sandbox));
	assert.match(
		shown,
		/\n {2}│ \+ \/\/ harmless note\\u\{2029\}\n {2}│ \+ payload\(\);\n/,
	);
});

test("a Windows line ending is a plain line end, with nothing to escape", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": "first();\r\nsecond();\r\n",
	});
	const shown = await shownAtTerminal(t, () => loadTrustedConfig(dir, sandbox));
	assert.match(shown, /\n {2}│ \+ first\(\);\n {2}│ \+ second\(\);\n$/);
});

/** Approve the project as it is, and load it once so the approved copy is kept. */
async function approveAndLoad(dir: string, sandbox: string): Promise<void> {
	await approve(dir, sandbox);
	await loadTrustedConfig(dir, sandbox);
}

const ALLOWING = [
	"export default {",
	'\tmasked: ["node_modules"],',
	'\tnetwork: { allow: ["registry.npmjs.org"] },',
	"};",
	"",
].join("\n");

test("a changed file is shown whole, with the lines that changed marked - as approved and + as they are now", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": ALLOWING });
	await approveAndLoad(dir, sandbox);
	await writeFile(
		join(dir, "playpen.config.js"),
		ALLOWING.replace("registry.npmjs.org", "evil.example"),
		"utf8",
	);
	const shown = await shownAtTerminal(t, () => loadTrustedConfig(dir, sandbox));
	assert.match(
		shown,
		/\n {2}── playpen\.config\.js \(changed\)\n {2}│ {3}export default \{\n {2}│ {3}\tmasked: \["node_modules"\],\n {2}│ - \tnetwork: \{ allow: \["registry\.npmjs\.org"\] \},\n {2}│ \+ \tnetwork: \{ allow: \["evil\.example"\] \},\n {2}│ {3}\};\n$/,
	);
});

test("a file that has not changed is named and not shown", async (t) => {
	const { dir, sandbox } = await scenario(t, {
		"playpen.config.js": 'import "./masks.js";',
		"masks.js": "masks();",
	});
	await approveAndLoad(dir, sandbox);
	await writeFile(join(dir, "masks.js"), "changed();", "utf8");
	const shown = await shownAtTerminal(t, () => loadTrustedConfig(dir, sandbox));
	assert.match(
		shown,
		/\n {2}│ \+ changed\(\);\n {2}── playpen\.config\.js \(unchanged\)\n$/,
	);
});

test("a changed file whose approved copy no longer matches its approved hash has every line marked +", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await approveAndLoad(dir, sandbox);
	await writeFile(
		join(trustDir(), sandbox, "playpen.config.js"),
		"changed();",
		"utf8",
	);
	await writeFile(
		join(dir, "playpen.config.js"),
		"changed();\nmore();",
		"utf8",
	);
	const shown = await shownAtTerminal(t, () => loadTrustedConfig(dir, sandbox));
	assert.match(
		shown,
		/\n {2}── playpen\.config\.js \(changed\)\n {2}│ \+ changed\(\);\n {2}│ \+ more\(\);\n$/,
	);
});

test("a changed file with no approved copy kept has every line marked +", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await approve(dir, sandbox);
	await writeFile(join(dir, "playpen.config.js"), "changed();", "utf8");
	const shown = await shownAtTerminal(t, () => loadTrustedConfig(dir, sandbox));
	assert.match(
		shown,
		/\n {2}── playpen\.config\.js \(changed\)\n {2}│ \+ changed\(\);\n$/,
	);
});

test("a change to only the newline at the end of a file is named, since no line shows it", async (t) => {
	const { dir, sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await approveAndLoad(dir, sandbox);
	await writeFile(join(dir, "playpen.config.js"), `${CONFIG}\n`, "utf8");
	const shown = await shownAtTerminal(t, () => loadTrustedConfig(dir, sandbox));
	assert.match(
		shown,
		/\n {2}── playpen\.config\.js \(changed only in line endings\)\n {2}│ {3}export default /,
	);
});

test("a format character that is not default-ignorable, U+FFF9, is escaped", () => {
	assert.equal(escapeUnshowable("a\ufff9b"), "a\\u{fff9}b");
});

test("a default-ignorable character that is not a format character, U+FE0F, is escaped", () => {
	assert.equal(escapeUnshowable("false\ufe0f"), "false\\u{fe0f}");
});

test("a character outside the basic plane, U+E0100, is one escape", () => {
	assert.equal(escapeUnshowable("a\u{e0100}b"), "a\\u{e0100}b");
});

test("a mount nobody approved is left out when there is no terminal to ask", async (t) => {
	const { sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	t.mock.method(console, "error", () => {});
	assert.deepEqual(await approveMounts(sandbox, ["/src/shared-lib"]), []);
});

test("a mount approved before is kept without asking", async (t) => {
	const { sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await pinMounts(sandbox, ["/src/shared-lib"]);
	t.mock.method(console, "error", () => {});
	assert.deepEqual(
		await approveMounts(sandbox, ["/src/shared-lib", "/src/other"]),
		["/src/shared-lib"],
	);
});

test("a mount approval is scoped to its sandbox", async (t) => {
	const { sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await pinMounts(sandbox, ["/src/shared-lib"]);
	t.mock.method(console, "error", () => {});
	assert.deepEqual(
		await approveMounts(`${sandbox}-other`, ["/src/shared-lib"]),
		[],
	);
});

test("a mount dropped from the config is forgotten, so naming it again asks again", async (t) => {
	const { sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	await pinMounts(sandbox, ["/src/shared-lib", "/src/other"]);
	t.mock.method(console, "error", () => {});
	await approveMounts(sandbox, ["/src/other"]);
	assert.deepEqual(
		await approveMounts(sandbox, ["/src/shared-lib", "/src/other"]),
		["/src/other"],
	);
});

test("a newline in a mount path is shown as an escape where there is no terminal to ask", async (t) => {
	const { sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	const said = t.mock.method(console, "error", () => {});
	await approveMounts(sandbox, ["/src/shared\n  approved"]);
	assert.match(
		String(said.mock.calls[0]?.arguments[0]),
		/^warning: not mounting \/src\/shared\\u\{a\} {2}approved: /,
	);
});

test("a newline in a mount path is shown as an escape in the question asked at a terminal", async (t) => {
	const { sandbox } = await scenario(t, { "playpen.config.js": CONFIG });
	const shown = await shownAtTerminal(t, () =>
		approveMounts(sandbox, ["/src/shared\n  approved"]),
	);
	assert.match(
		shown,
		/^this project asks to mount \/src\/shared\\u\{a\} {2}approved read-only\.$/m,
	);
});
