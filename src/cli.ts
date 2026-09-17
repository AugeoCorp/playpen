#!/usr/bin/env node
import { runMain } from "citty";
import { main } from "./main.ts";

// Answered before citty parses anything: this runs on every keypress that
// completes a playpen command, and is not something anyone types.
if (process.argv[2] === "__complete") {
	const { complete } = await import("./completion.ts");
	console.log(await complete(main, process.argv.slice(3)));
} else {
	runMain(main);
}
