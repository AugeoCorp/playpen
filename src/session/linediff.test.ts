import assert from "node:assert/strict";
import { test } from "node:test";
import { allAdded, unifiedDiff } from "./linediff.ts";

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

test("files whose comparison table is exactly at the cap are still compared", () => {
	const lines = Array.from({ length: 999 }, (_, i) => `line ${i}`);
	assert.deepEqual(unifiedDiff(lines, [...lines]), []);
});

test("files one line past the cap give null instead of a diff", () => {
	const lines = Array.from({ length: 999 }, (_, i) => `line ${i}`);
	assert.equal(unifiedDiff(lines, [...lines, "one more"]), null);
});
test("a file shown on its own is all added, with a header counting its lines from line 0", () => {
	assert.deepEqual(allAdded(["-a", " b"]), ["@@ -0,0 +1,2 @@", "+-a", "+ b"]);
});
