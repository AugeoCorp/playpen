import assert from "node:assert/strict";
import { test } from "node:test";
import type { HeldSecret } from "./fence.ts";
import { rewriteHeaders } from "./inject.ts";

const GH_TOKEN: HeldSecret = { env: "GH_TOKEN", value: "ghp_real" };
const NPM_TOKEN: HeldSecret = { env: "NPM_TOKEN", value: "npm_real" };

function basic(credentials: string): string {
	return `Basic ${Buffer.from(credentials, "latin1").toString("base64")}`;
}

test("an Authorization header gets the real value in place of the placeholder", () => {
	assert.deepEqual(
		rewriteHeaders(
			[["Authorization", "token playpen-secret-gh-token"]],
			[GH_TOKEN],
		),
		{ headers: [["Authorization", "token ghp_real"]], injected: ["GH_TOKEN"] },
	);
});

test("Basic credentials are decoded, get the real value, and are encoded again", () => {
	assert.deepEqual(
		rewriteHeaders(
			[["Authorization", basic("x-access-token:playpen-secret-gh-token")]],
			[GH_TOKEN],
		),
		{
			headers: [["Authorization", basic("x-access-token:ghp_real")]],
			injected: ["GH_TOKEN"],
		},
	);
});

test("the Basic scheme is matched whatever its case", () => {
	const encoded = basic("user:playpen-secret-gh-token").slice("Basic ".length);
	const { headers } = rewriteHeaders(
		[["authorization", `BASIC ${encoded}`]],
		[GH_TOKEN],
	);
	assert.deepEqual(headers, [
		["authorization", `BASIC ${basic("user:ghp_real").slice("Basic ".length)}`],
	]);
});

test("a byte in Basic credentials that is not UTF-8 comes back unchanged around the real value", () => {
	const { headers } = rewriteHeaders(
		[["Authorization", basic("caf\xe9:playpen-secret-gh-token")]],
		[GH_TOKEN],
	);
	assert.deepEqual(headers, [["Authorization", basic("caf\xe9:ghp_real")]]);
});

test("a placeholder in any header but Authorization goes out as it is, and nothing is listed", () => {
	const sent: [string, string][] = [
		["Host", "api.example"],
		["X-Token", "playpen-secret-gh-token"],
		["Cookie", "session=playpen-secret-gh-token"],
	];
	assert.deepEqual(rewriteHeaders(sent, [GH_TOKEN]), {
		headers: sent,
		injected: [],
	});
});

test("two secrets' placeholders in one Authorization are both replaced, and each is listed", () => {
	assert.deepEqual(
		rewriteHeaders(
			[
				[
					"Authorization",
					basic("playpen-secret-gh-token:playpen-secret-npm-token"),
				],
			],
			[GH_TOKEN, NPM_TOKEN],
		),
		{
			headers: [["Authorization", basic("ghp_real:npm_real")]],
			injected: ["GH_TOKEN", "NPM_TOKEN"],
		},
	);
});

test("a placeholder for a secret this host may not have is left alone", () => {
	const sent: [string, string][] = [
		["Authorization", "Bearer playpen-secret-npm-token"],
	];
	assert.deepEqual(rewriteHeaders(sent, [GH_TOKEN]), {
		headers: sent,
		injected: [],
	});
});

test("a placeholder that begins a longer one does not take the front of it", () => {
	const GH: HeldSecret = { env: "GH", value: "short" };
	const { headers } = rewriteHeaders(
		[["Authorization", "token playpen-secret-gh-token"]],
		[GH, GH_TOKEN],
	);
	assert.deepEqual(headers, [["Authorization", "token ghp_real"]]);
});
