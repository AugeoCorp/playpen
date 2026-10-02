import assert from "node:assert/strict";
import { test } from "node:test";
import { unifiedDiff } from "./linediff.ts";

const TEN = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

test("one changed line gives one hunk with three lines of context either side", () => {
	assert.deepEqual(
		unifiedDiff(TEN, ["1", "2", "3", "4", "5", "six", "7", "8", "9", "10"]),
		["@@ -3,7 +3,7 @@", " 3", " 4", " 5", "-6", "+six", " 7", " 8", " 9"],
	);
});

test("an added line shows as one + line, and the new side counts one more", () => {
	assert.deepEqual(
		unifiedDiff(TEN, [
			"1",
			"2",
			"3",
			"4",
			"5",
			"new",
			"6",
			"7",
			"8",
			"9",
			"10",
		]),
		["@@ -3,6 +3,7 @@", " 3", " 4", " 5", "+new", " 6", " 7", " 8"],
	);
});

test("a removed line shows as one - line, and the new side counts one fewer", () => {
	assert.deepEqual(
		unifiedDiff(TEN, ["1", "2", "3", "4", "5", "7", "8", "9", "10"]),
		["@@ -3,7 +3,6 @@", " 3", " 4", " 5", "-6", " 7", " 8", " 9"],
	);
});

test("context stops at the start and end of the file", () => {
	assert.deepEqual(unifiedDiff(["a", "b"], ["A", "b"]), [
		"@@ -1,2 +1,2 @@",
		"-a",
		"+A",
		" b",
	]);
});

test("lines added to an empty file are counted from line 0 on the old side", () => {
	assert.deepEqual(unifiedDiff([], ["a", "b"]), [
		"@@ -0,0 +1,2 @@",
		"+a",
		"+b",
	]);
});

test("changes with seven unchanged lines between them get a hunk each, since their context would not touch", () => {
	assert.deepEqual(
		unifiedDiff(TEN, ["one", "2", "3", "4", "5", "6", "7", "8", "nine", "10"]),
		[
			"@@ -1,4 +1,4 @@",
			"-1",
			"+one",
			" 2",
			" 3",
			" 4",
			"@@ -6,5 +6,5 @@",
			" 6",
			" 7",
			" 8",
			"-9",
			"+nine",
			" 10",
		],
	);
});

test("changes with six unchanged lines between them share one hunk, since their context would touch", () => {
	assert.deepEqual(
		unifiedDiff(TEN, ["1", "two", "3", "4", "5", "6", "7", "8", "nine", "10"]),
		[
			"@@ -1,10 +1,10 @@",
			" 1",
			"-2",
			"+two",
			" 3",
			" 4",
			" 5",
			" 6",
			" 7",
			" 8",
			"-9",
			"+nine",
			" 10",
		],
	);
});

test("equal files have no hunks", () => {
	assert.deepEqual(unifiedDiff(TEN, [...TEN]), []);
});

test("files too long to compare give null instead of a diff", () => {
	const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
	assert.equal(unifiedDiff(long, long), null);
});
