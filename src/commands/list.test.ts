import assert from "node:assert/strict";
import { test } from "node:test";
import type { FenceState } from "../network/fence.ts";
import { netLabel } from "./list.ts";

const cases: Array<[FenceState | null, string]> = [
	["sealed", "sealed"],
	["sealed-no-egress", "no egress"],
	["sealed-no-gatekeeper", "no gate"],
	["unsealed", "OPEN"],
	["stopped", "-"],
	[null, "?"],
];

test("every fence state, and a fence status that could not be read, has its own NET label", () => {
	for (const [state, label] of cases) {
		assert.equal(netLabel(state), label);
	}
	const labels = new Set(cases.map(([, label]) => label));
	assert.equal(labels.size, cases.length);
});
