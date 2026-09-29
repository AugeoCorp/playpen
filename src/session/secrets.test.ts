import assert from "node:assert/strict";
import { test } from "node:test";
import { missingMessage, readSecretValues } from "./secrets.ts";

const gh = { env: "GH_TOKEN", hosts: ["api.github.com", "github.com"] };
const npm = { env: "NPM_TOKEN", hosts: ["registry.example.com"] };

test("each granted variable is read, by name", () => {
	const { held, missing } = readSecretValues([gh, npm], {
		GH_TOKEN: "ghp_abc",
		NPM_TOKEN: "npm_abc",
	});
	assert.deepEqual(held, [
		{ env: "GH_TOKEN", value: "ghp_abc" },
		{ env: "NPM_TOKEN", value: "npm_abc" },
	]);
	assert.deepEqual(missing, []);
});

test("no grants means no variables are read and nothing is held", () => {
	assert.deepEqual(readSecretValues([], {}), { held: [], missing: [] });
});

test("a variable that is not set is reported missing, and the rest are still read", () => {
	assert.deepEqual(readSecretValues([gh, npm], { NPM_TOKEN: "npm_abc" }), {
		held: [{ env: "NPM_TOKEN", value: "npm_abc" }],
		missing: ["GH_TOKEN"],
	});
});

test("an empty variable counts as not set", () => {
	assert.deepEqual(readSecretValues([gh], { GH_TOKEN: "" }), {
		held: [],
		missing: ["GH_TOKEN"],
	});
});

test("every missing variable is reported, in the order the config lists them", () => {
	const aws = { env: "AWS_KEY", hosts: ["aws.example.com"] };
	assert.deepEqual(readSecretValues([gh, npm, aws], {}).missing, [
		"GH_TOKEN",
		"NPM_TOKEN",
		"AWS_KEY",
	]);
});

test("a variable named by two grants is held once", () => {
	const again = { env: "GH_TOKEN", hosts: ["gist.github.com"] };
	assert.deepEqual(readSecretValues([gh, again], { GH_TOKEN: "ghp_abc" }), {
		held: [{ env: "GH_TOKEN", value: "ghp_abc" }],
		missing: [],
	});
});

test("one missing name is listed on its own", () => {
	assert.equal(
		missingMessage(["GH_TOKEN"]),
		"network.secrets needs GH_TOKEN set in your environment",
	);
});

test("two missing names are joined with 'and'", () => {
	assert.equal(
		missingMessage(["GH_TOKEN", "AWS_KEY"]),
		"network.secrets needs GH_TOKEN and AWS_KEY set in your environment",
	);
});

test("three missing names are listed with commas and 'and'", () => {
	assert.equal(
		missingMessage(["GH_TOKEN", "NPM_TOKEN", "AWS_KEY"]),
		"network.secrets needs GH_TOKEN, NPM_TOKEN and AWS_KEY set in your environment",
	);
});
