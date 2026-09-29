import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxHistoryDir } from "./history.ts";

test("a sandbox's history is kept in a directory named after it", () => {
	assert.ok(sandboxHistoryDir("playpen-90957d").endsWith("/playpen-90957d"));
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
		assert.throws(() => sandboxHistoryDir(name), /invalid sandbox name/, name);
	}
});
