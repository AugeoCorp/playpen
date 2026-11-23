import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { SecretGrant } from "../network/policy.ts";
import {
	placeholderProfile,
	readEnvFiles,
	takeSecretValues,
} from "./secrets.ts";

const GH: SecretGrant = { env: "GH_TOKEN", hosts: ["api.github.com"] };
const NPM: SecretGrant = { env: "NPM_TOKEN", hosts: ["registry.npmjs.org"] };

test("each granted variable's value is taken, by name", () => {
	const env = { GH_TOKEN: "ghp_a", NPM_TOKEN: "npm_b", HOME: "/home/me" };
	assert.deepEqual(takeSecretValues([GH, NPM], env, {}), [
		{ env: "GH_TOKEN", value: "ghp_a" },
		{ env: "NPM_TOKEN", value: "npm_b" },
	]);
});

test("a taken variable is gone from the environment, and the rest stay", () => {
	const env = { GH_TOKEN: "ghp_a", HOME: "/home/me" };
	takeSecretValues([GH], env, {});
	assert.deepEqual(env, { HOME: "/home/me" });
});

test("a variable unset or empty everywhere is refused, naming every one, and the rest are still taken", () => {
	const env = { GH_TOKEN: "", NPM_TOKEN: "npm_b" };
	assert.throws(
		() =>
			takeSecretValues(
				[GH, { env: "CARGO_TOKEN", hosts: ["crates.io"] }, NPM],
				env,
				{ GH_TOKEN: "" },
			),
		{
			message:
				"network.secrets needs GH_TOKEN, CARGO_TOKEN set in your environment, .env.local or .env",
		},
	);
	assert.deepEqual(env, {});
});

test("a variable unset or empty in the environment is read from the env files", () => {
	const env = { GH_TOKEN: "" };
	assert.deepEqual(
		takeSecretValues([GH, NPM], env, {
			GH_TOKEN: "ghp_file",
			NPM_TOKEN: "npm_file",
		}),
		[
			{ env: "GH_TOKEN", value: "ghp_file" },
			{ env: "NPM_TOKEN", value: "npm_file" },
		],
	);
});

test("the environment wins over the env files", () => {
	const env = { GH_TOKEN: "ghp_environment" };
	assert.deepEqual(takeSecretValues([GH], env, { GH_TOKEN: "ghp_file" }), [
		{ env: "GH_TOKEN", value: "ghp_environment" },
	]);
});

test("an env file's variable that no grant names is not taken", () => {
	const env = { GH_TOKEN: "ghp_a" };
	assert.deepEqual(
		takeSecretValues([GH], env, { DATABASE_URL: "postgres://" }),
		[{ env: "GH_TOKEN", value: "ghp_a" }],
	);
});

test("a variable named by two grants is held once", () => {
	const env = { GH_TOKEN: "ghp_a" };
	assert.deepEqual(
		takeSecretValues([GH, { env: "GH_TOKEN", hosts: ["github.com"] }], env, {}),
		[{ env: "GH_TOKEN", value: "ghp_a" }],
	);
});

test("a value that cannot go in a request header is refused, naming the variable and not the value", () => {
	const env = { GH_TOKEN: "ghp_a\nghp_b" };
	assert.throws(
		() => takeSecretValues([GH], env, {}),
		(error: Error) => {
			assert.match(error.message, /GH_TOKEN holds a character/);
			assert.equal(error.message.includes("ghp_"), false);
			return true;
		},
	);
});

test("a shell that sources the profile holds each secret's placeholder", () => {
	const shell = spawnSync(
		"sh",
		["-c", 'eval "$(cat)"; printf "%s %s" "$GH_TOKEN" "$NPM_TOKEN"'],
		{ input: placeholderProfile([GH, NPM, GH]), encoding: "utf8" },
	);
	assert.equal(
		shell.stdout,
		"playpen-secret-gh-token playpen-secret-npm-token",
	);
});

test("every granted variable is taken before any value is refused", () => {
	const env = { GH_TOKEN: "ghp_a\nghp_b", NPM_TOKEN: "npm_b" };
	assert.throws(() => takeSecretValues([GH, NPM], env, {}));
	assert.deepEqual(env, {});
});

async function project(
	t: TestContext,
	files: Record<string, string>,
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "playpen-secrets-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await Promise.all(
		Object.entries(files).map(([name, content]) =>
			writeFile(join(dir, name), content),
		),
	);
	return dir;
}

test("a project's .env is read", async (t) => {
	const dir = await project(t, { ".env": "GH_TOKEN=ghp_a\n" });
	assert.deepEqual(await readEnvFiles(dir), { GH_TOKEN: "ghp_a" });
});

test("a variable in .env.local wins over the same one in .env, and the rest of .env is kept", async (t) => {
	const dir = await project(t, {
		".env": "GH_TOKEN=ghp_shared\nNPM_TOKEN=npm_shared\n",
		".env.local": "GH_TOKEN=ghp_mine\n",
	});
	assert.deepEqual(await readEnvFiles(dir), {
		GH_TOKEN: "ghp_mine",
		NPM_TOKEN: "npm_shared",
	});
});

test("a project with neither file sets nothing", async (t) => {
	const dir = await project(t, {});
	assert.deepEqual(await readEnvFiles(dir), {});
});

test("a .env that is a link is refused, even to a file with the variable in it", async (t) => {
	const dir = await project(t, { elsewhere: "GH_TOKEN=ghp_a\n" });
	await symlink(join(dir, "elsewhere"), join(dir, ".env"));
	await assert.rejects(readEnvFiles(dir), {
		message: `${join(dir, ".env")} is not a regular file, so network.secrets will not read it`,
	});
});

test("a .env.local that is a directory is refused", async (t) => {
	const dir = await project(t, {});
	await mkdir(join(dir, ".env.local"));
	await assert.rejects(readEnvFiles(dir), /\.env\.local is not a regular file/);
});

test("a .env that is a fifo is refused without waiting for a writer", async (t) => {
	const dir = await project(t, {});
	spawnSync("mkfifo", [join(dir, ".env")]);
	await assert.rejects(readEnvFiles(dir), /\.env is not a regular file/);
});
