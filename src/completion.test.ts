import assert from "node:assert/strict";
import { test } from "node:test";
import { bashScript, complete, zshScript } from "./completion.ts";
import { ALIASES, main } from "./main.ts";

/** The words typed after `playpen`, the last one being completed. */
async function offered(...typed: string[]): Promise<string[]> {
	const reply = await complete(main, ["--", ...typed], ALIASES);
	return reply.split("\n").slice(1);
}

/** What `offered` returns, without the flags, in a stable order. */
async function commandsOffered(...typed: string[]): Promise<string[]> {
	const candidates = await offered(...typed);
	return candidates.filter((c) => !c.startsWith("-")).sort();
}

async function described(...typed: string[]): Promise<string[]> {
	const reply = await complete(main, ["--describe", "--", ...typed]);
	return reply.split("\n").slice(1);
}

async function directive(...typed: string[]): Promise<string> {
	const reply = await complete(main, ["--", ...typed]);
	return reply.split("\n")[0] ?? "";
}

test("offers every command at the top level", async () => {
	assert.deepEqual(await commandsOffered(""), [
		"claude",
		"completion",
		"doctor",
		"image",
		"list",
		"remove",
		"run",
		"setup",
		"shell",
		"start",
		"stop",
	]);
});

test("narrows to the commands matching what has been typed so far", async () => {
	assert.deepEqual(await offered("cl"), ["claude"]);
});

test("moves on to a subcommand's own subcommands", async () => {
	assert.deepEqual(await offered("image", "sh"), ["show"]);
});

test("offers the off switch for a flag that is already on", async () => {
	assert.deepEqual(await offered("claude", "--no"), ["--no-auth", "--no-sync"]);
});

test("offers a one-letter alias with a single dash", async () => {
	const candidates = await offered("remove", "-");
	assert.ok(candidates.includes("-y"), `no -y among ${candidates}`);
});

test("offers the values a positional accepts when its hint lists them", async () => {
	assert.deepEqual(await offered("completion", ""), ["bash", "zsh", "--help"]);
});

test("asks the shell for directories after a flag that takes one", async () => {
	assert.equal(await directive("image", "show", "--mount", ""), ":dirs");
});

test("offers programs to run in the guest right after --", async () => {
	assert.equal(await directive("run", "--", "np"), ":commands");
});

test("leaves the arguments of that program alone", async () => {
	assert.equal(await directive("run", "--", "npm", "ru"), ":files");
});

test("offers nothing at all after a command that does not exist", async () => {
	assert.deepEqual(await offered("bogus", ""), []);
});

test("stops offering a flag once it is on the line", async () => {
	assert.deepEqual(await offered("list", "--help", ""), []);
});

test("stops offering the off switch once the flag itself is on the line", async () => {
	const candidates = await offered("claude", "--auth", "--");
	assert.ok(
		!candidates.includes("--no-auth"),
		`--auth is already set, so --no-auth is dead: ${candidates}`,
	);
});

test("stops offering an alias of a flag already on the line", async () => {
	const candidates = await offered("remove", "--yes", "-");
	assert.ok(!candidates.includes("-y"), `--yes is set, yet: ${candidates}`);
});

test("counts a flag given as --name=value as already on the line", async () => {
	const candidates = await offered("image", "show", "--mount=/tmp", "--m");
	assert.deepEqual(candidates, []);
});

test("offers --version only at the top level", async () => {
	assert.ok((await offered("")).includes("--version"), "missing at the root");
	const inside = await offered("list", "");
	assert.ok(!inside.includes("--version"), `offered inside list: ${inside}`);
});

test("attaches a description to each candidate for zsh's menu", async () => {
	assert.deepEqual(await described("image", "bui"), [
		"build:Bake the base image that sandboxes clone from",
	]);
});

test("leaves descriptions out for bash, which has nowhere to show them", async () => {
	assert.deepEqual(await offered("image", "bui"), ["build"]);
});

test("keeps a description that itself contains a colon in one piece", async () => {
	assert.deepEqual(await described("image", "show", "--mou"), [
		"--mount:Directory to render as the mount (default: cwd)",
	]);
});

test("the bash script asks playpen rather than listing the commands itself", async () => {
	const script = bashScript("playpen");
	assert.match(script, /playpen __complete/);
	assert.doesNotMatch(
		script,
		/claude/,
		"a command name in the script means it can go stale",
	);
});

test("the bash script registers itself against the command name", () => {
	assert.match(bashScript("playpen"), /complete .*-F _playpen playpen$/m);
});

test("the zsh script declares which command it completes", () => {
	assert.equal(zshScript("playpen").split("\n")[0], "#compdef playpen");
});

test("the zsh script asks for descriptions, since its menu shows them", () => {
	assert.match(zshScript("playpen"), /__complete --describe/);
});

test("offers the full name of a command, not its short alias", async () => {
	const candidates = await offered("l");
	assert.deepEqual(candidates, ["list"]);
});

test("replaces a short alias with the command it stands for", async () => {
	assert.deepEqual(await offered("ls"), ["list"]);
	assert.deepEqual(await offered("rm"), ["remove"]);
});

test("reaches a command whose alias is the only thing that matches", async () => {
	assert.deepEqual(await offered("u"), ["start"]);
});

test("does not expand an alias inside a subcommand, where it means nothing", async () => {
	assert.deepEqual(await offered("image", "ls"), []);
});

test("completes a command typed by its short alias", async () => {
	assert.deepEqual(await offered("ls", "--h"), ["--help"]);
});
