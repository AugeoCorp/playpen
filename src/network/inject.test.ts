import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteHeaders } from "./inject.ts";

const GH_TOKEN = { env: "GH_TOKEN", value: "ghp_real" };
const NPM_TOKEN = { env: "NPM_TOKEN", value: "npm_real" };

test("a token authorization gets the real value in place of the placeholder", () => {
	const { headers } = rewriteHeaders(
		["Authorization", "token playpen-secret-gh-token"],
		[GH_TOKEN],
	);
	assert.deepEqual(headers, ["Authorization", "token ghp_real"]);
});

test("a Bearer authorization gets the real value in place of the placeholder", () => {
	const { headers } = rewriteHeaders(
		["authorization", "Bearer playpen-secret-gh-token"],
		[GH_TOKEN],
	);
	assert.deepEqual(headers, ["authorization", "Bearer ghp_real"]);
});

test("Basic credentials are decoded, get the real value, and are encoded again", () => {
	// base64("x-access-token:playpen-secret-gh-token")
	const sent = "Basic eC1hY2Nlc3MtdG9rZW46cGxheXBlbi1zZWNyZXQtZ2gtdG9rZW4=";
	const { headers, injected } = rewriteHeaders(
		["Authorization", sent],
		[GH_TOKEN],
	);
	// base64("x-access-token:ghp_real")
	assert.deepEqual(headers, [
		"Authorization",
		"Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3JlYWw=",
	]);
	assert.deepEqual(injected, [{ header: "Authorization", env: "GH_TOKEN" }]);
});

test("the Basic scheme is matched whatever its case", () => {
	const { headers } = rewriteHeaders(
		[
			"Authorization",
			"basic eC1hY2Nlc3MtdG9rZW46cGxheXBlbi1zZWNyZXQtZ2gtdG9rZW4=",
		],
		[GH_TOKEN],
	);
	assert.deepEqual(headers, [
		"Authorization",
		"basic eC1hY2Nlc3MtdG9rZW46Z2hwX3JlYWw=",
	]);
});

test("Basic credentials that are not valid base64 are left exactly as sent", () => {
	const sent = "Basic not*base64!";
	const { headers, injected } = rewriteHeaders(
		["Authorization", sent],
		[GH_TOKEN],
	);
	assert.deepEqual(headers, ["Authorization", sent]);
	assert.deepEqual(injected, []);
});

test("any other header carrying the placeholder verbatim gets the value too", () => {
	const { headers, injected } = rewriteHeaders(
		["X-Api-Key", "playpen-secret-gh-token"],
		[GH_TOKEN],
	);
	assert.deepEqual(headers, ["X-Api-Key", "ghp_real"]);
	assert.deepEqual(injected, [{ header: "X-Api-Key", env: "GH_TOKEN" }]);
});

test("headers without a placeholder pass through unchanged, names and order included", () => {
	const sent = [
		"Host",
		"api.github.com",
		"Accept",
		"application/json",
		"Authorization",
		"token something-else",
	];
	const { headers, injected } = rewriteHeaders(sent, [GH_TOKEN]);
	assert.deepEqual(headers, sent);
	assert.deepEqual(injected, []);
});

test("two placeholders in one request are both replaced, and each is listed with its header", () => {
	const { headers, injected } = rewriteHeaders(
		[
			"Authorization",
			"token playpen-secret-gh-token",
			"X-Npm",
			"playpen-secret-npm-token",
		],
		[GH_TOKEN, NPM_TOKEN],
	);
	assert.deepEqual(headers, [
		"Authorization",
		"token ghp_real",
		"X-Npm",
		"npm_real",
	]);
	assert.deepEqual(injected, [
		{ header: "Authorization", env: "GH_TOKEN" },
		{ header: "X-Npm", env: "NPM_TOKEN" },
	]);
});

test("the count of injections is one per header and secret, however often the placeholder repeats in it", () => {
	const { injected } = rewriteHeaders(
		["X-Twice", "playpen-secret-gh-token,playpen-secret-gh-token"],
		[GH_TOKEN],
	);
	assert.equal(injected.length, 1);
});

test("a placeholder for a secret not granted to this host is left alone", () => {
	const { headers, injected } = rewriteHeaders(
		["Authorization", "token playpen-secret-npm-token"],
		[GH_TOKEN],
	);
	assert.deepEqual(headers, [
		"Authorization",
		"token playpen-secret-npm-token",
	]);
	assert.deepEqual(injected, []);
});

test("a placeholder that begins a longer one does not take the front of it", () => {
	const { headers } = rewriteHeaders(
		["Authorization", "token playpen-secret-gh-token"],
		[
			{ env: "GH", value: "short_real" },
			{ env: "GH_TOKEN", value: "ghp_real" },
		],
	);
	assert.deepEqual(headers, ["Authorization", "token ghp_real"]);
});

test("with no secrets for the host, nothing changes", () => {
	const sent = ["Authorization", "token playpen-secret-gh-token"];
	const { headers, injected } = rewriteHeaders(sent, []);
	assert.deepEqual(headers, sent);
	assert.deepEqual(injected, []);
});
