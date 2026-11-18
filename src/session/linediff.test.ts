import assert from "node:assert/strict";
import { test } from "node:test";
import { markChanges } from "./linediff.ts";

test("a changed line is marked - as it was and + as it is, between the unchanged lines around it", () => {
	assert.deepEqual(markChanges(["a", "b", "c"], ["a", "B", "c"]), [
		" a",
		"-b",
		"+B",
		" c",
	]);
});

test("an added line is marked +", () => {
	assert.deepEqual(markChanges(["a", "c"], ["a", "b", "c"]), [
		" a",
		"+b",
		" c",
	]);
});

test("a removed line is marked -", () => {
	assert.deepEqual(markChanges(["a", "b", "c"], ["a", "c"]), [
		" a",
		"-b",
		" c",
	]);
});

test("a line that was there before, added again elsewhere, is marked + where it was added", () => {
	assert.deepEqual(markChanges(["a", "b"], ["a", "b", "a"]), [
		" a",
		" b",
		"+a",
	]);
});

test("with nothing before, every line is marked +", () => {
	assert.deepEqual(markChanges([], ["a", "b"]), ["+a", "+b"]);
});

test("files with too many lines to compare have every line marked +", () => {
	const lines = Array.from({ length: 1000 }, () => "same");
	assert.equal(markChanges(lines, lines)[0], "+same");
});
