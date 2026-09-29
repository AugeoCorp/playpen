import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { placeholderFor } from "../network/policy.ts";
import {
	missingMessage,
	PROFILE_PATH,
	profileCommand,
	readSecretValues,
} from "./secrets.ts";

const gh = { env: "GH_TOKEN", hosts: ["api.github.com", "github.com"] };
const npm = { env: "NPM_TOKEN", hosts: ["registry.example.com"] };

test("a placeholder is the variable's name in lower case with dashes", () => {
	assert.equal(placeholderFor("GH_TOKEN"), "playpen-secret-gh-token");
	assert.equal(placeholderFor("_MY_2ND_KEY"), "playpen-secret--my-2nd-key");
});

test("two placeholders for the same variable are the same", () => {
	assert.equal(placeholderFor("GH_TOKEN"), placeholderFor("GH_TOKEN"));
});

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

/** Runs `script` as the guest would, under a stricter umask than the script sets for itself. */
function runProfileScript(t: TestContext, placeholder: string) {
	const dir = mkdtempSync(join(tmpdir(), "profile-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "playpen-secrets.sh");
	const { script, input } = profileCommand(
		[{ env: "EVIL", placeholder }],
		path,
	);
	const wrote = spawnSync("bash", ["-c", `umask 077; ${script}`], {
		input,
		encoding: "utf8",
	});
	return { dir, path, wrote };
}

test("the profile a login shell sources gives back a hostile placeholder exactly", (t) => {
	const hostile = "x'; touch pwned; ' $(touch pwned) `touch pwned` \\ \"";
	const { dir, path, wrote } = runProfileScript(t, hostile);
	assert.equal(wrote.status, 0, wrote.stderr);
	const read = spawnSync("sh", ["-c", `. "$0"; printf %s "$EVIL"`, path], {
		encoding: "utf8",
		cwd: dir,
	});
	assert.equal(read.stdout, hostile);
	assert.deepEqual(readdirSync(dir), ["playpen-secrets.sh"]);
});

test("the profile is readable by everyone whatever umask the shell had", (t) => {
	const { path, wrote } = runProfileScript(t, "playpen-secret-evil");
	assert.equal(wrote.status, 0, wrote.stderr);
	assert.equal(statSync(path).mode & 0o777, 0o644);
});

test("with no secrets the profile is removed, so one dropped from the config leaves the guest", () => {
	assert.deepEqual(profileCommand([]), { script: `rm -f ${PROFILE_PATH}` });
});
