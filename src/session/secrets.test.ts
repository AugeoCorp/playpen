import assert from "node:assert/strict";
import { test } from "node:test";
import {
	PROFILE_PATH,
	placeholderFor,
	profileCommand,
	readSecretValues,
} from "./secrets.ts";

const gh = { env: "GH_TOKEN", hosts: ["api.github.com", "github.com"] };
const npm = { env: "NPM_TOKEN", hosts: ["registry.example.com"] };

test("a placeholder is the variable's name in lower case with dashes, then sixteen hex digits", () => {
	assert.match(
		placeholderFor("GH_TOKEN"),
		/^playpen-secret-gh-token-[0-9a-f]{16}$/,
	);
	assert.match(
		placeholderFor("_MY_2ND_KEY"),
		/^playpen-secret--my-2nd-key-[0-9a-f]{16}$/,
	);
});

test("two placeholders for the same variable differ", () => {
	assert.notEqual(placeholderFor("GH_TOKEN"), placeholderFor("GH_TOKEN"));
});

test("each granted variable is read with its hosts and given a placeholder", () => {
	const held = readSecretValues([gh, npm], {
		GH_TOKEN: "ghp_abc",
		NPM_TOKEN: "npm_abc",
	});
	assert.deepEqual(
		held.map(({ env, value, hosts }) => ({ env, value, hosts })),
		[
			{ env: "GH_TOKEN", value: "ghp_abc", hosts: gh.hosts },
			{ env: "NPM_TOKEN", value: "npm_abc", hosts: npm.hosts },
		],
	);
	assert.match(held[1]?.placeholder ?? "", /^playpen-secret-npm-token-/);
});

test("no grants means no variables are read and nothing is held", () => {
	assert.deepEqual(readSecretValues([], {}), []);
});

test("one variable that is not set is named in the refusal", () => {
	assert.throws(() => readSecretValues([gh, npm], { NPM_TOKEN: "npm_abc" }), {
		message: "network.secrets needs GH_TOKEN set in your environment",
	});
});

test("an empty variable counts as not set", () => {
	assert.throws(() => readSecretValues([gh], { GH_TOKEN: "" }), {
		message: "network.secrets needs GH_TOKEN set in your environment",
	});
});

test("every missing variable is listed in one refusal, and one that is set is left out", () => {
	const aws = { env: "AWS_KEY", hosts: ["aws.example.com"] };
	assert.throws(
		() => readSecretValues([gh, npm, aws], { NPM_TOKEN: "npm_secret" }),
		(err: Error) => {
			assert.equal(
				err.message,
				"network.secrets needs GH_TOKEN and AWS_KEY set in your environment",
			);
			return true;
		},
	);
	assert.throws(() => readSecretValues([gh, npm, aws], {}), {
		message:
			"network.secrets needs GH_TOKEN, NPM_TOKEN and AWS_KEY set in your environment",
	});
});

test("the profile exports each placeholder, quoted, one line per secret", () => {
	const { input } = profileCommand([
		{
			env: "GH_TOKEN",
			placeholder: "playpen-secret-gh-token-3f9a0c1d5e7b2468",
		},
		{
			env: "NPM_TOKEN",
			placeholder: "playpen-secret-npm-token-0123456789abcdef",
		},
	]);
	assert.equal(
		input,
		"export GH_TOKEN='playpen-secret-gh-token-3f9a0c1d5e7b2468'\n" +
			"export NPM_TOKEN='playpen-secret-npm-token-0123456789abcdef'\n",
	);
});

test("a quote in a placeholder cannot end its quoting", () => {
	const { input } = profileCommand([
		{ env: "GH_TOKEN", placeholder: "x'; touch /tmp/pwned; '" },
	]);
	assert.equal(input, "export GH_TOKEN='x'\\''; touch /tmp/pwned; '\\'''\n");
});

test("the script that writes the profile is the same whatever the placeholders are", () => {
	const one = profileCommand([{ env: "A", placeholder: "playpen-secret-a-1" }]);
	const two = profileCommand([{ env: "B", placeholder: "playpen-secret-b-2" }]);
	assert.equal(one.script, two.script);
	assert.match(
		one.script,
		new RegExp(`mv ${PROFILE_PATH}\\.tmp ${PROFILE_PATH}`),
	);
});

test("with no secrets the profile is removed, so one dropped from the config leaves the guest", () => {
	assert.deepEqual(profileCommand([]), { script: `rm -f ${PROFILE_PATH}` });
});
