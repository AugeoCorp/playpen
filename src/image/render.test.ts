import assert from "node:assert/strict";
import { test } from "node:test";
import { baseImage } from "./base.ts";
import { type ImageOptions, imageHash, renderBase } from "./render.ts";

const PEM = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";

const opts: ImageOptions = {
	cpus: 2,
	memory: "2GiB",
	disk: "8GiB",
	mountType: "virtiofs",
};

test("the template keeps Lima from answering the guest's name lookups from inside the fence", () => {
	const { template } = renderBase(baseImage(PEM), opts);
	assert.deepEqual(template.hostResolver, { enabled: false });
});

test("the template keeps Lima from copying the host's proxy variables into the guest", () => {
	const { template } = renderBase(baseImage(PEM), opts);
	assert.equal(template.propagateProxyEnv, false);
});

test("a different CA certificate gives a different image hash, so an old base is rebuilt", () => {
	const other = PEM.replace("AAAA", "BBBB");
	assert.notEqual(imageHash(baseImage(PEM)), imageHash(baseImage(other)));
	assert.equal(imageHash(baseImage(PEM)), imageHash(baseImage(PEM)));
});
