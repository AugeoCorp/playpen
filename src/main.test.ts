import assert from "node:assert/strict";
import { test } from "node:test";
import { ALIASES, main } from "./main.ts";

const commands = Object.keys(main.subCommands ?? {});

test("every short alias stands for a command that exists", () => {
	const dangling = Object.entries(ALIASES).filter(
		([, name]) => !commands.includes(name),
	);
	assert.deepEqual(dangling, [], "these aliases point at nothing");
});

test("no alias is also a command of its own", () => {
	const shadowed = Object.keys(ALIASES).filter((alias) =>
		commands.includes(alias),
	);
	assert.deepEqual(shadowed, [], "the rewrite would hide these commands");
});
