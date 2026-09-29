import assert from "node:assert/strict";
import { test } from "node:test";
import { capture, TIMED_OUT } from "./sh.ts";

test("a command that never exits is killed at its timeout and reported as timed out, even with a child still holding its output open", {
	timeout: 10_000,
}, async () => {
	const result = await capture("sh", ["-c", "sleep 30 & exec sleep 30"], {
		timeoutMs: 200,
	});

	assert.equal(result.code, TIMED_OUT);
	assert.equal(result.stderr, "sh timed out after 0.2s");
});

test("a command that finishes inside its timeout is answered as usual", async () => {
	const result = await capture("sh", ["-c", "echo done; exit 3"], {
		timeoutMs: 10_000,
	});

	assert.deepEqual(result, { code: 3, stdout: "done\n", stderr: "" });
});
