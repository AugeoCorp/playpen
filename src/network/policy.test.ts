import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, HOST_ALIAS, type Policy, PROBE_HOST } from "./policy.ts";

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
		reach: "public",
		reason: 'matches allow entry "github.com"',
	});
});

test("a bare hostname entry's reach is public only: it may not resolve inside", () => {
	const v = decide(enforcing(["github.com"]), "github.com", 443);
	assert.equal(v.kind, "allow");
	assert.equal(v.reach, "public");
});

test("a host:port entry's reach is any: it may resolve to loopback or a LAN address", () => {
	const v = decide(
		enforcing(["internal.foo.com:8080"]),
		"internal.foo.com",
		8080,
	);
	assert.equal(v.kind, "allow");
	assert.equal(v.reach, "any");
});

test("an unlisted name in log mode is reported with reach public, same as a bare entry", () => {
	const v = decide(logging([]), "unlisted.example", 443);
	assert.equal(v.kind, "report");
	assert.equal(v.reach, "public");
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
	const allow = ["93.184.216.34:443"];
	assert.equal(decide(enforcing(allow), "93.184.216.34", 443).kind, "allow");
	assert.equal(decide(enforcing(allow), "93.184.216.35", 443).kind, "deny");
});

test("an IPv4 entry allows only the port it names", () => {
	const allow = ["93.184.216.34:443"];
	assert.equal(decide(enforcing(allow), "93.184.216.34", 443).kind, "allow");
	assert.equal(decide(enforcing(allow), "93.184.216.34", 80).kind, "deny");
});

test("an IPv4 entry without a port opens nothing, since the port is required", () => {
	const allow = ["93.184.216.34"];
	assert.equal(decide(enforcing(allow), "93.184.216.34", 443).kind, "deny");
	assert.equal(decide(logging(allow), "93.184.216.34", 443).kind, "report");
});

test("a LAN address the project names is reachable, on that port alone", () => {
	const allow = ["192.168.1.50:5432"];
	assert.equal(decide(enforcing(allow), "192.168.1.50", 5432).kind, "allow");
	assert.equal(decide(enforcing(allow), "192.168.1.50", 5433).kind, "deny");
	assert.equal(decide(logging(allow), "192.168.1.50", 5433).kind, "deny");
});

test("a bare IP literal that is not listed is denied", () => {
	const v = decide(enforcing(["github.com"]), "93.184.216.34", 443);
	assert.equal(v.kind, "deny");
});

/** What a request must not reach by naming its address: this machine (0/8,
 * which Linux reads as loopback, and 127/8), the cloud metadata service, the
 * networks this machine is on, and the ranges nothing routes. */
const NOT_PUBLIC = [
	"0.0.0.0",
	"127.0.0.2",
	"169.254.169.254",
	"10.0.0.7",
	"172.16.5.4",
	"192.168.1.50",
	"100.64.0.1",
	"224.0.0.1",
	"255.255.255.255",
];

test("an address that is not a public one is denied, and log mode does not soften it", () => {
	for (const address of NOT_PUBLIC) {
		assert.equal(
			decide(enforcing([]), address, 22).kind,
			"deny",
			`expected ${address} to be denied`,
		);
		assert.equal(
			decide(logging([]), address, 22).kind,
			"deny",
			`expected ${address} to be denied in log mode too`,
		);
	}
});

test("an address on this machine stays denied even when the allow list names it", () => {
	for (const address of ["0.0.0.0", "127.0.0.2", "169.254.169.254"]) {
		assert.equal(
			decide(enforcing([`${address}:22`]), address, 22).kind,
			"deny",
			`expected ${address} to be denied although it is listed`,
		);
		assert.equal(
			decide(logging([`${address}:22`]), address, 22).kind,
			"deny",
			`expected ${address} to be denied in log mode although it is listed`,
		);
	}
});

test("host.playpen.internal is allowed and mapped to 127.0.0.1 when its port has a localhost entry", () => {
	const v = decide(enforcing(["localhost:9001"]), HOST_ALIAS, 9001);
	assert.deepEqual(v, {
		kind: "allow",
		target: { host: "127.0.0.1", port: 9001 },
		reach: "public",
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
		reach: "public",
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

test("probe.playpen.internal is answered as a probe, never dialed, and needs no allow entry", () => {
	const v = decide(enforcing([]), PROBE_HOST, 80);
	assert.deepEqual(v, {
		kind: "probe",
		reason: `${PROBE_HOST} is the fence's own liveness check; nothing is dialed`,
	});
});

test("probe.playpen.internal stays a probe even when log mode would allow anything", () => {
	assert.equal(decide(logging([]), PROBE_HOST, 80).kind, "probe");
});

test("probe.playpen.internal stays a probe even when the project allows it by name", () => {
	assert.equal(decide(enforcing([PROBE_HOST]), PROBE_HOST, 443).kind, "probe");
});
