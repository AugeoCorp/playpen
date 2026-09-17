import assert from "node:assert/strict";
import { test } from "node:test";
import { answer, type Policy, verdict } from "./policy.ts";

const allowing = (...allow: string[]): Policy => ({ allow, enforce: true });

test("an empty allowlist reaches anything", () => {
	assert.equal(
		verdict({ allow: [], enforce: true }, "anywhere.example"),
		"allow",
	);
});

test("a listed domain is reached, and its subdomains with it", () => {
	const p = allowing("example.com");
	assert.equal(verdict(p, "example.com"), "allow");
	assert.equal(verdict(p, "files.example.com"), "allow");
});

test("a suffix match stops at a label boundary", () => {
	assert.equal(verdict(allowing("example.com"), "notexample.com"), "deny");
});

test("case and a trailing dot do not change the verdict", () => {
	const p = allowing("Example.COM");
	assert.equal(verdict(p, "files.example.com."), "allow");
});

test("an unlisted domain is denied", () => {
	assert.equal(verdict(allowing("example.com"), "elsewhere.example"), "deny");
});

test("without enforcement a denial is only recorded", () => {
	const p: Policy = { allow: ["example.com"], enforce: false };
	assert.equal(answer(p, "elsewhere.example"), "report");
	assert.equal(answer(p, "example.com"), "allow");
});
