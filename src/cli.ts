#!/usr/bin/env node
import { runMain } from "citty";
import { ALIASES, main } from "./main.ts";

const [command, ...rest] = process.argv.slice(2);

// Answered before citty parses anything: this runs on every keypress that
// completes a playpen command, and is not something anyone types.
if (command === "__complete") {
	const { complete } = await import("./completion.ts");
	console.log(await complete(main, rest, ALIASES));
} else if (command === "__net-helper" || command === "__net-inside") {
	// The two halves of the network fence, routed here for the same reason as
	// `__complete`: playpen spawns them, nobody types them. See network/fence.ts.
	const [sandbox, instance] = rest;
	if (sandbox === undefined || instance === undefined) {
		console.error(`usage: playpen ${command} <sandbox> <instance>`);
		process.exit(2);
	}
	const helper = await import("./network/helper.ts");
	const run = command === "__net-helper" ? helper.runHelper : helper.runInside;
	process.exitCode = await run(sandbox, instance);
} else {
	const rawArgs =
		command === undefined ? [] : [ALIASES[command] ?? command, ...rest];
	runMain(main, { rawArgs });
}
