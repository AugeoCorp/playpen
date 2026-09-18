import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import * as net from "node:net";
import { type TestContext, test } from "node:test";
import { startGatekeeper } from "./gatekeeper.ts";
import { HOST_ALIAS, type Policy, PROBE_HOST } from "./policy.ts";

/** A local TCP server that writes a banner before the client sends anything,
 * then echoes whatever it receives back with a prefix — so the test can tell
 * the banner and the echo apart on the wire. Cleanup destroys any sockets
 * still open itself, rather than relying on the order `t.after` hooks run
 * in: `server.close()` alone would wait forever for a connection this test's
 * own client hook has not yet torn down. */
function bannerServer(t: TestContext, bind = "127.0.0.1"): Promise<number> {
	return new Promise((resolve) => {
		const sockets = new Set<net.Socket>();
		const server = net.createServer((socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.write("banner\r\n");
			socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
		});
		t.after(
			() =>
				new Promise<void>((r) => {
					for (const socket of sockets) socket.destroy();
					server.close(() => r());
				}),
		);
		server.listen(0, bind, () => {
			resolve((server.address() as net.AddressInfo).port);
		});
	});
}

/** Sends a raw CONNECT and resolves with the status line plus whatever bytes
 * arrive after it, read as a client would over the tunnel. */
function connectRaw(
	t: TestContext,
	proxyPort: number,
	target: string,
): Promise<{ status: string; socket: net.Socket; afterHeaders: Buffer }> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(proxyPort, "127.0.0.1");
		t.after(() => socket.destroy());
		socket.once("connect", () => {
			socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
		});
		let header = Buffer.alloc(0);
		socket.on("data", function onHeader(chunk) {
			header = Buffer.concat([header, chunk]);
			const end = header.indexOf("\r\n\r\n");
			if (end === -1) return;
			socket.off("data", onHeader);
			const status = header.subarray(0, header.indexOf("\r\n")).toString();
			resolve({ status, socket, afterHeaders: header.subarray(end + 4) });
		});
		socket.on("error", reject);
	});
}

/** The CONNECT status line, or "closed" when the proxy hung up without
 * answering -- which is what a refused address looks like on the wire, since
 * the tunnel is torn down rather than answered once the dial is refused. */
function connectStatus(
	t: TestContext,
	proxyPort: number,
	target: string,
): Promise<string> {
	return new Promise((resolve) => {
		const socket = net.connect(proxyPort, "127.0.0.1");
		t.after(() => socket.destroy());
		socket.once("connect", () => {
			socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
		});
		let header = "";
		socket.on("data", (chunk) => {
			header += String(chunk);
			if (header.includes("\r\n"))
				resolve(header.slice(0, header.indexOf("\r\n")));
		});
		socket.on("error", () => resolve("closed"));
		socket.on("close", () => resolve("closed"));
	});
}

/** Reads from `socket` until at least `minLength` bytes (including any bytes
 * already read past the CONNECT response headers) have arrived. */
function readAtLeast(
	socket: net.Socket,
	already: Buffer,
	minLength: number,
): Promise<Buffer> {
	return new Promise((resolve) => {
		let buf = already;
		if (buf.length >= minLength) {
			resolve(buf);
			return;
		}
		socket.on("data", function onData(chunk) {
			buf = Buffer.concat([buf, chunk]);
			if (buf.length >= minLength) {
				socket.off("data", onData);
				resolve(buf);
			}
		});
	});
}

function policyFor(port: number, mode: Policy["mode"] = "enforce"): Policy {
	return { allow: [`localhost:${port}`], mode };
}

test("a CONNECT to the local alias reaches the local server, banner first", async (t) => {
	const localPort = await bannerServer(t);
	const gatekeeper = await startGatekeeper({
		policy: () => policyFor(localPort),
		log: () => {},
	});
	t.after(() => gatekeeper.close());

	const { status, socket, afterHeaders } = await connectRaw(
		t,
		gatekeeper.port,
		`${HOST_ALIAS}:${localPort}`,
	);
	assert.match(status, / 200 /);

	// The banner must be visible before the client has written anything.
	const banner = await readAtLeast(socket, afterHeaders, "banner\r\n".length);
	assert.equal(banner.toString(), "banner\r\n");

	socket.write("hello\n");
	const echoed = await readAtLeast(
		socket,
		Buffer.alloc(0),
		"echo:hello\n".length,
	);
	assert.equal(echoed.toString(), "echo:hello\n");
});

test("a policy replaced while the gatekeeper runs decides the connections after it", async (t) => {
	const localPort = await bannerServer(t);
	let policy: Policy = { allow: [], mode: "enforce" };
	const gatekeeper = await startGatekeeper({
		policy: () => policy,
		log: () => {},
	});
	t.after(() => gatekeeper.close());

	const before = await connectStatus(
		t,
		gatekeeper.port,
		`${HOST_ALIAS}:${localPort}`,
	);
	assert.match(before, / 403 /);

	policy = policyFor(localPort);
	const after = await connectStatus(
		t,
		gatekeeper.port,
		`${HOST_ALIAS}:${localPort}`,
	);
	assert.match(after, / 200 /);
});

test("a CONNECT to a host outside the policy is refused with 403, before any upstream connection", async (t) => {
	const entries: Array<{ verdict: string; reason: string }> = [];
	const gatekeeper = await startGatekeeper({
		policy: () => ({ allow: [], mode: "enforce" }),
		log: (line) => entries.push(line),
	});
	t.after(() => gatekeeper.close());

	const { status } = await connectRaw(t, gatekeeper.port, "example.com:443");
	assert.match(status, / 403 /);
	assert.deepEqual(
		entries.map((e) => e.verdict),
		["deny"],
	);
	assert.match(entries[0]?.reason ?? "", /not in the allow list/);
});

test("a CONNECT to a bare IP literal is refused with 403", async (t) => {
	const gatekeeper = await startGatekeeper({
		policy: () => ({ allow: [], mode: "enforce" }),
		log: () => {},
	});
	t.after(() => gatekeeper.close());

	const { status } = await connectRaw(t, gatekeeper.port, "93.184.216.34:443");
	assert.match(status, / 403 /);
});

/** Resolves every name to `address`, and records the names it was asked for,
 * so a test can say what a host answers with without touching the network. */
function resolverFor(address: string): {
	asked: string[];
	resolve: (host: string) => Promise<LookupAddress[]>;
} {
	const asked: string[] = [];
	return {
		asked,
		resolve: async (host) => {
			asked.push(host);
			return [{ address, family: 4 }];
		},
	};
}

test("in log mode, a CONNECT to an address on this machine is refused with 403", async (t) => {
	// Bound on every address, so both spellings below name a service that is
	// really listening: what refuses them is the policy, not a dead port.
	const localPort = await bannerServer(t, "0.0.0.0");
	const gatekeeper = await startGatekeeper({
		policy: () => ({ allow: [], mode: "log" }),
		log: () => {},
	});
	t.after(() => gatekeeper.close());

	for (const address of ["127.0.0.2", "0.0.0.0"]) {
		const status = await connectStatus(
			t,
			gatekeeper.port,
			`${address}:${localPort}`,
		);
		assert.match(status, / 403 /, `expected ${address} to be refused`);
	}
});

test("an allowed name that resolves onto this machine is refused, and the refusal is logged", async (t) => {
	const localPort = await bannerServer(t);
	const resolver = resolverFor("127.0.0.1");
	const entries: Array<{ verdict: string; reason: string }> = [];
	const gatekeeper = await startGatekeeper({
		policy: () => ({ allow: ["mirror.example"], mode: "enforce" }),
		log: (line) => entries.push(line),
		resolve: resolver.resolve,
	});
	t.after(() => gatekeeper.close());

	const status = await connectStatus(
		t,
		gatekeeper.port,
		`mirror.example:${localPort}`,
	);
	assert.equal(status, "closed");
	assert.deepEqual(
		entries.map((e) => e.verdict),
		["allow", "deny"],
	);
	assert.match(entries[1]?.reason ?? "", /127\.0\.0\.1/);
});

test("in log mode, an unlisted name is reported rather than refused, and still cannot land on this machine", async (t) => {
	const resolver = resolverFor("127.0.0.1");
	const entries: Array<{ verdict: string; reason: string }> = [];
	const gatekeeper = await startGatekeeper({
		policy: () => ({ allow: [], mode: "log" }),
		log: (line) => entries.push(line),
		resolve: resolver.resolve,
	});
	t.after(() => gatekeeper.close());

	const status = await connectStatus(t, gatekeeper.port, "unlisted.example:80");
	assert.equal(status, "closed");
	assert.deepEqual(
		entries.map((e) => e.verdict),
		["report", "deny"],
	);
});

test("an allowed name is resolved as the allow entry spells it, whatever the request's case and trailing dot", async (t) => {
	const resolver = resolverFor("127.0.0.1");
	const gatekeeper = await startGatekeeper({
		policy: () => ({ allow: ["mirror.example"], mode: "enforce" }),
		log: () => {},
		resolve: resolver.resolve,
	});
	t.after(() => gatekeeper.close());

	await connectStatus(t, gatekeeper.port, "MIRROR.Example.:443");
	assert.deepEqual(resolver.asked, ["mirror.example"]);
});

test("log mode still refuses this machine's loopback", async (t) => {
	const localPort = await bannerServer(t);
	const gatekeeper = await startGatekeeper({
		policy: () => ({ allow: [], mode: "log" }),
		log: () => {},
	});
	t.after(() => gatekeeper.close());

	const direct = await connectRaw(t, gatekeeper.port, `127.0.0.1:${localPort}`);
	assert.match(direct.status, / 403 /);
	const alias = await connectRaw(
		t,
		gatekeeper.port,
		`${HOST_ALIAS}:${localPort}`,
	);
	assert.match(alias.status, / 403 /);
});

test("a CONNECT to the probe name is refused with 403 and logged as a probe, not a deny", async (t) => {
	const entries: Array<{ verdict: string; host: string }> = [];
	const gatekeeper = await startGatekeeper({
		policy: () => ({ allow: [], mode: "enforce" }),
		log: (line) => entries.push(line),
	});
	t.after(() => gatekeeper.close());

	const { status } = await connectRaw(t, gatekeeper.port, `${PROBE_HOST}:80`);
	assert.match(status, / 403 /);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.verdict, "probe");
	assert.equal(entries[0]?.host, PROBE_HOST);
});
