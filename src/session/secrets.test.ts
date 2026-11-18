import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type { SecretGrant } from "../network/policy.ts";
import { takeSecretValues } from "./secrets.ts";

const GH: SecretGrant = { env: "GH_TOKEN", hosts: ["api.github.com"] };
const NPM: SecretGrant = { env: "NPM_TOKEN", hosts: ["registry.npmjs.org"] };

test("each granted variable's value is taken, by name", () => {
	const env = { GH_TOKEN: "ghp_a", NPM_TOKEN: "npm_b", HOME: "/home/me" };
	assert.deepEqual(takeSecretValues([GH, NPM], env), {
		held: [
			{ env: "GH_TOKEN", value: "ghp_a" },
			{ env: "NPM_TOKEN", value: "npm_b" },
		],
		missing: [],
	});
});

test("a taken variable is gone from the environment, and the rest stay", () => {
	const env = { GH_TOKEN: "ghp_a", HOME: "/home/me" };
	takeSecretValues([GH], env);
	assert.deepEqual(env, { HOME: "/home/me" });
});

test("a child spawned after a variable is taken does not see it", (t) => {
	process.env.PLAYPEN_TEST_TOKEN = "ghp_a";
	t.after(() => {
		delete process.env.PLAYPEN_TEST_TOKEN;
	});
	takeSecretValues(
		[{ env: "PLAYPEN_TEST_TOKEN", hosts: ["a.example"] }],
		process.env,
	);
	const child = spawnSync(
		process.execPath,
		["-e", "process.stdout.write(String(process.env.PLAYPEN_TEST_TOKEN))"],
		{ encoding: "utf8" },
	);
	assert.equal(child.stdout, "undefined");
});

test("an unset or empty variable is reported missing, and the rest are still taken", () => {
	const env = { GH_TOKEN: "", NPM_TOKEN: "npm_b" };
	assert.deepEqual(
		takeSecretValues(
			[GH, { env: "CARGO_TOKEN", hosts: ["crates.io"] }, NPM],
			env,
		),
		{
			held: [{ env: "NPM_TOKEN", value: "npm_b" }],
			missing: ["GH_TOKEN", "CARGO_TOKEN"],
		},
	);
});

test("a variable named by two grants is held once", () => {
	const env = { GH_TOKEN: "ghp_a" };
	const { held } = takeSecretValues(
		[GH, { env: "GH_TOKEN", hosts: ["github.com"] }],
		env,
	);
	assert.deepEqual(held, [{ env: "GH_TOKEN", value: "ghp_a" }]);
});

test("a value that cannot go in a request header is refused, naming the variable and not the value", () => {
	const env = { GH_TOKEN: "ghp_a\nghp_b" };
	assert.throws(
		() => takeSecretValues([GH], env),
		(error: Error) => {
			assert.match(error.message, /GH_TOKEN holds a character/);
			assert.equal(error.message.includes("ghp_"), false);
			return true;
		},
	);
});
