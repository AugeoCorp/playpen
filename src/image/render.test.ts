import assert from "node:assert/strict";
import { test } from "node:test";
import { baseImage } from "./base.ts";
import { type ImageOptions, renderBase } from "./render.ts";

const opts: ImageOptions = {
	cpus: 2,
	memory: "2GiB",
	disk: "8GiB",
	mountType: "virtiofs",
};

test("the template keeps Lima from answering the guest's name lookups from inside the fence", () => {
	const { template } = renderBase(baseImage, opts);
	assert.deepEqual(template.hostResolver, { enabled: false });
});

test("the template keeps Lima from copying the host's proxy variables into the guest", () => {
	const { template } = renderBase(baseImage, opts);
	assert.equal(template.propagateProxyEnv, false);
});
