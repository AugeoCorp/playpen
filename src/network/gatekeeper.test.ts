import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import { type TestContext, test } from "node:test";
import { startGatekeeper } from "./gatekeeper.ts";
import { HOST_ALIAS, type Policy } from "./policy.ts";

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
		policy: policyFor(localPort),
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

test("a CONNECT to a host outside the policy is refused with 403, before any upstream connection", async (t) => {
	const entries: Array<{ verdict: string; reason: string }> = [];
	const gatekeeper = await startGatekeeper({
		policy: { allow: [], mode: "enforce" },
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
		policy: { allow: [], mode: "enforce" },
		log: () => {},
	});
	t.after(() => gatekeeper.close());

	const { status } = await connectRaw(t, gatekeeper.port, "93.184.216.34:443");
	assert.match(status, / 403 /);
});

/** A non-loopback address of this machine, so a test can dial an unlisted
 * IP literal that still lands on a server the test owns. */
function outwardAddress(): string | null {
	for (const iface of Object.values(os.networkInterfaces())) {
		for (const info of iface ?? []) {
			if (info.family === "IPv4" && !info.internal) return info.address;
		}
	}
	return null;
}

test("in log mode, a host outside the policy is let through and logged as report", async (t) => {
	// A real external host would make this depend on the network. An unlisted
	// IP literal is refused the same way, and this machine's own outward
	// address is one the banner server can be reached on without leaving it.
	const address = outwardAddress();
	if (address === null) {
		t.skip("no non-loopback IPv4 address on this machine");
		return;
	}
	const localPort = await bannerServer(t, "0.0.0.0");
	const entries: Array<{ verdict: string; reason: string }> = [];
	const gatekeeper = await startGatekeeper({
		policy: { allow: [], mode: "log" },
		log: (line) => entries.push(line),
	});
	t.after(() => gatekeeper.close());

	const { status, socket, afterHeaders } = await connectRaw(
		t,
		gatekeeper.port,
		`${address}:${localPort}`,
	);
	assert.match(status, / 200 /);
	const banner = await readAtLeast(socket, afterHeaders, "banner\r\n".length);
	assert.equal(banner.toString(), "banner\r\n");
	assert.deepEqual(
		entries.map((e) => e.verdict),
		["report"],
	);
	assert.match(entries[0]?.reason ?? "", /not in the allow list/);
});

test("log mode still refuses this machine's loopback", async (t) => {
	const localPort = await bannerServer(t);
	const gatekeeper = await startGatekeeper({
		policy: { allow: [], mode: "log" },
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
