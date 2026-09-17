import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, HOST_ALIAS, type Policy } from "./policy.ts";

function enforcing(allow: readonly string[]): Policy {
	return { allow, mode: "enforce" };
}

function logging(allow: readonly string[]): Policy {
	return { allow, mode: "log" };
}

test("a bare hostname entry allows the host itself", () => {
	const v = decide(enforcing(["github.com"]), "github.com", 443);
	assert.deepEqual(v, {
		kind: "allow",
		target: { host: "github.com", port: 443 },
		reason: 'matches allow entry "github.com"',
	});
});

test("a bare hostname entry allows any subdomain", () => {
	const v = decide(enforcing(["github.com"]), "api.github.com", 443);
	assert.equal(v.kind, "allow");
});

test("a bare hostname entry allows any port", () => {
	const v = decide(enforcing(["github.com"]), "github.com", 8443);
	assert.equal(v.kind, "allow");
});

test("a bare hostname entry does not allow an unrelated host that merely ends with it", () => {
	const v = decide(enforcing(["github.com"]), "evilgithub.com", 443);
	assert.equal(v.kind, "deny");
});

test("a host:port entry allows only that port", () => {
	const allow = ["example.com:443"];
	assert.equal(decide(enforcing(allow), "example.com", 443).kind, "allow");
	assert.equal(decide(enforcing(allow), "example.com", 80).kind, "deny");
});

test("a host:port entry still covers subdomains, at that port", () => {
	const v = decide(enforcing(["example.com:443"]), "cdn.example.com", 443);
	assert.equal(v.kind, "allow");
});

test("an IPv4 entry allows only that exact address", () => {
	const v = decide(enforcing(["93.184.216.34"]), "93.184.216.34", 443);
	assert.equal(v.kind, "allow");
});

test("an IPv4 entry does not allow a different address", () => {
	const v = decide(enforcing(["93.184.216.34"]), "93.184.216.35", 443);
	assert.equal(v.kind, "deny");
});

test("an IPv4 entry with a port allows only that port", () => {
	const allow = ["93.184.216.34:443"];
	assert.equal(decide(enforcing(allow), "93.184.216.34", 443).kind, "allow");
	assert.equal(decide(enforcing(allow), "93.184.216.34", 80).kind, "deny");
});

test("a bare IP literal that is not listed is denied", () => {
	const v = decide(enforcing(["github.com"]), "93.184.216.34", 443);
	assert.equal(v.kind, "deny");
});

test("host.playpen.internal is allowed and mapped to 127.0.0.1 when its port has a localhost entry", () => {
	const v = decide(enforcing(["localhost:9001"]), HOST_ALIAS, 9001);
	assert.deepEqual(v, {
		kind: "allow",
		target: { host: "127.0.0.1", port: 9001 },
		reason: `${HOST_ALIAS}:9001 maps to 127.0.0.1 via a localhost:9001 entry`,
	});
});

test("host.playpen.internal is denied on a port with no matching localhost entry", () => {
	const v = decide(enforcing(["localhost:9001"]), HOST_ALIAS, 9002);
	assert.equal(v.kind, "deny");
});

test("plain localhost from the guest is denied even when localhost:PORT is allowed", () => {
	const v = decide(enforcing(["localhost:9001"]), "localhost", 9001);
	assert.equal(v.kind, "deny");
});

test("plain 127.0.0.1 from the guest is denied", () => {
	const v = decide(enforcing(["127.0.0.1"]), "127.0.0.1", 9001);
	assert.equal(v.kind, "deny");
});

test("hostname comparison is case-insensitive", () => {
	const v = decide(enforcing(["GitHub.com"]), "GITHUB.COM", 443);
	assert.equal(v.kind, "allow");
});

test("hostname comparison ignores a trailing dot on the request", () => {
	const v = decide(enforcing(["github.com"]), "github.com.", 443);
	assert.equal(v.kind, "allow");
});

test("hostname comparison ignores a trailing dot on the allow entry", () => {
	const v = decide(enforcing(["github.com."]), "github.com", 443);
	assert.equal(v.kind, "allow");
});

test("an unparseable hostname is denied", () => {
	const v = decide(enforcing(["github.com"]), "not a host*name", 443);
	assert.equal(v.kind, "deny");
});

test("in log mode, a host that would be denied is reported and allowed instead", () => {
	const v = decide(logging([]), "example.com", 443);
	assert.deepEqual(v, {
		kind: "report",
		target: { host: "example.com", port: 443 },
		reason: "example.com is not in the allow list",
	});
});

test("log mode never opens this machine: localhost, 127.0.0.1 and an unlisted alias port stay denied", () => {
	assert.equal(decide(logging([]), "localhost", 22).kind, "deny");
	assert.equal(decide(logging([]), "127.0.0.1", 22).kind, "deny");
	assert.equal(decide(logging([]), HOST_ALIAS, 11434).kind, "deny");
});

test("in log mode, a host that is actually allowed is still a plain allow, not a report", () => {
	const v = decide(logging(["github.com"]), "github.com", 443);
	assert.equal(v.kind, "allow");
});
