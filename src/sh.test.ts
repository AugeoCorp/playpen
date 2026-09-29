import assert from "node:assert/strict";
import { test } from "node:test";
import { captureBuffer } from "./sh.ts";

test("a command that exits without reading its input answers with its exit code, not a failed write", async () => {
	// Far more than a pipe holds, so the write is still going when the command exits.
	const input = Buffer.alloc(8 * 1024 * 1024);
	const result = await captureBuffer(
		process.execPath,
		["-e", "process.stderr.write('instance is stopped'); process.exit(3)"],
		{},
		input,
	);
	assert.equal(result.code, 3);
	assert.equal(result.stderr, "instance is stopped");
});
