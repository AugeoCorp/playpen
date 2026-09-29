import assert from "node:assert/strict";
import { test } from "node:test";
import { archivePath, hostDir } from "./history.ts";

test("a sandbox's history directory and its old archive are named after it", () => {
	assert.ok(hostDir("playpen-90957d").endsWith("/history/playpen-90957d"));
	assert.ok(
		archivePath("playpen-90957d").endsWith("/history/playpen-90957d.tar"),
	);
});

test("a name that could escape the history directory is refused", () => {
	for (const name of [
		"../escape",
		"/etc/passwd",
		"has space",
		"UPPER",
		"",
		"-leading",
	]) {
		assert.throws(() => hostDir(name), /invalid sandbox name/, name);
		assert.throws(() => archivePath(name), /invalid sandbox name/, name);
	}
});
