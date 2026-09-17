#!/usr/bin/env node
import { runMain } from "citty";
import { ALIASES, main } from "./main.ts";

const [command, ...rest] = process.argv.slice(2);

// Answered before citty parses anything: this runs on every keypress that
// completes a playpen command, and is not something anyone types.
if (command === "__complete") {
	const { complete } = await import("./completion.ts");
	console.log(await complete(main, rest, ALIASES));
} else {
	const rawArgs =
		command === undefined ? [] : [ALIASES[command] ?? command, ...rest];
	runMain(main, { rawArgs });
}
