import assert from "node:assert/strict";
import { test } from "node:test";
import { netLabel } from "./list.ts";

test("a sealed fence reads as sealed", () => {
	assert.equal(netLabel("sealed"), "sealed");
});

test("a fenced VM with no gatekeeper answering reads as no gate", () => {
	assert.equal(netLabel("sealed-no-gatekeeper"), "no gate");
});

test("a VM running outside the fence reads as OPEN, in upper case to stand out", () => {
	assert.equal(netLabel("unsealed"), "OPEN");
});

test("a stopped sandbox has no network state to show", () => {
	assert.equal(netLabel("stopped"), "-");
});

test("a fence status that could not be read shows a question mark, not a crash", () => {
	assert.equal(netLabel(null), "?");
});
