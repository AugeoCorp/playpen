import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, type TestContext, test } from "node:test";
import tls from "node:tls";
import { type Ca, ensureCa } from "./ca.ts";
import type { HeldSecret } from "./fence.ts";
import { type LogEntry, startGatekeeper } from "./gatekeeper.ts";
import { interceptor } from "./intercept.ts";
import { leafMinter } from "./leaf.ts";
import { HOST_ALIAS, type Policy } from "./policy.ts";

/** The install's CA, whose certificates the guest trusts. */
let playpenCa: Ca;
/** A stand-in for a public CA, signing the upstream host's own certificate. */
let publicCa: Ca;
const dataHomes: string[] = [];
const savedDataHome = process.env.XDG_DATA_HOME;

async function caIn(prefix: string): Promise<Ca> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dataHomes.push(dir);
	process.env.XDG_DATA_HOME = dir;
	return ensureCa();
}

before(async () => {
	playpenCa = await caIn("playpen-intercept-");
	publicCa = await caIn("playpen-upstream-");
});

after(async () => {
	if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = savedDataHome;
	for (const dir of dataHomes) await rm(dir, { recursive: true, force: true });
});

const GH_TOKEN: HeldSecret = { env: "GH_TOKEN", value: "ghp_real_value" };
const PLACEHOLDER = "playpen-secret-gh-token";

/** `api.example` is allowed, and GH_TOKEN may be sent to it. */
function secretPolicy(extraAllow: readonly string[] = []): Policy {
	return {
		allow: ["api.example", ...extraAllow],
		mode: "enforce",
		ports: [],
		secrets: [{ env: "GH_TOKEN", hosts: ["api.example"] }],
	};
}

interface Received {
	authorization: string | undefined;
	rawHeaders: string[];
	servername: string;
}

/**
 * The real host, as far as these tests go: an HTTPS server with a certificate
 * from `publicCa`, which answers every request with a fixed body and a header
 * of its own.
 */
async function upstreamHost(
	t: TestContext,
): Promise<{ port: number; received: Received[] }> {
	const contextFor = leafMinter(publicCa);
	const received: Received[] = [];
	const server = https.createServer(
		{ SNICallback: (name, done) => done(null, contextFor(name)) },
		(req, res) => {
			req.resume();
			req.on("end", () => {
				received.push({
					authorization: req.headers.authorization,
					rawHeaders: req.rawHeaders,
					servername: (req.socket as tls.TLSSocket).servername || "",
				});
				res.setHeader("x-upstream", "yes");
				res.end("hello from upstream");
			});
		},
	);
	// Closed here rather than left to the client's cleanup, which runs after
	// this; `closeAllConnections` misses a connection that never sent a
	// request.
	const open = new Set<tls.TLSSocket>();
	server.on("secureConnection", (socket: tls.TLSSocket) => {
		open.add(socket);
		socket.on("close", () => open.delete(socket));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	t.after(
		() =>
			new Promise<void>((r) => {
				for (const socket of open) socket.destroy();
				server.close(() => r());
			}),
	);
	return { port: (server.address() as net.AddressInfo).port, received };
}

/** Every value `received` got for the header `name`, whatever its case. */
function headersNamed(received: Received | undefined, name: string): string[] {
	const raw = received?.rawHeaders ?? [];
	return raw.filter(
		(_, i) => i % 2 === 1 && raw[i - 1]?.toLowerCase() === name,
	);
}

/**
 * The host a test's upstream really is: the interceptor is told the approved
 * host and port, and this sends it to the test's own loopback server instead,
 * trusting `publicCa` there. The server name is left as the interceptor set it.
 */
function toUpstream(
	port: number,
): (options: tls.ConnectionOptions) => tls.TLSSocket {
	return (options) =>
		tls.connect({ ...options, host: "127.0.0.1", port, ca: publicCa.certPem });
}

/** The gatekeeper with the interceptor, holding GH_TOKEN, with every line it
 * logs collected. */
async function gatekeeperWith(
	t: TestContext,
	opts: {
		policy: () => Policy;
		upstreamPort?: number;
		resolveTo?: string;
	},
): Promise<{ port: number; log: LogEntry[] }> {
	const log: LogEntry[] = [];
	const record = (line: LogEntry) => log.push(line);
	const gatekeeper = await startGatekeeper({
		policy: opts.policy,
		log: record,
		resolve: async () => [
			{ address: opts.resolveTo ?? "127.0.0.1", family: 4 },
		],
		intercept: interceptor({
			held: [GH_TOKEN],
			contextFor: leafMinter(playpenCa),
			log: record,
			...(opts.upstreamPort === undefined
				? {}
				: { connect: toUpstream(opts.upstreamPort) }),
		}),
	});
	t.after(() => gatekeeper.close());
	return { port: gatekeeper.port, log };
}

/**
 * Sends a CONNECT and resolves with the tunnel once it is answered 200, or
 * rejects with the status line, or "closed" if the proxy hung up instead.
 *
 * The caller owns an open tunnel, and closes it through the TLS socket
 * wrapped around it.
 */
function tunnel(proxyPort: number, target: string): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(proxyPort, "127.0.0.1");
		const refuse = (why: string) => {
			socket.destroy();
			reject(new Error(why));
		};
		socket.once("connect", () =>
			socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
		);
		let header = "";
		const onData = (chunk: Buffer) => {
			header += chunk.toString("latin1");
			const end = header.indexOf("\r\n\r\n");
			if (end === -1) return;
			socket.off("data", onData);
			const status = header.slice(0, header.indexOf("\r\n"));
			if (/ 200 /.test(status)) resolve(socket);
			else refuse(status);
		};
		socket.on("data", onData);
		socket.on("error", () => refuse("closed"));
		socket.on("close", () => refuse("closed"));
	});
}

/** TLS over a tunnel, trusting only `ca`, as a guest trusting the playpen CA
 * and nothing else would. Closed when the test ends. */
function tlsOver(
	t: TestContext,
	socket: net.Socket,
	servername: string,
	ca: Ca = playpenCa,
): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		const secure = tls.connect(
			{ socket, servername, ca: ca.certPem, ALPNProtocols: ["http/1.1"] },
			() => resolve(secure),
		);
		t.after(() => secure.destroy());
		secure.on("error", reject);
	});
}

/**
 * An HTTPS client whose every connection is a fresh tunnel through the
 * gatekeeper, so the number of `allow` lines logged is the number of
 * connections it opened.
 */
function clientThrough(
	t: TestContext,
	proxyPort: number,
	target: string,
	trust: { servername?: string; ca?: Ca } = {},
): https.Agent {
	const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
	const servername = trust.servername ?? target.split(":")[0] ?? "";
	agent.createConnection = (_options, done) => {
		tunnel(proxyPort, target)
			.then((socket) => tlsOver(t, socket, servername, trust.ca))
			.then(
				(secure) => done?.(null, secure),
				(err: Error) => done?.(err, undefined as never),
			);
		return undefined;
	};
	t.after(() => agent.destroy());
	return agent;
}

/** One GET for `/user` over `agent`. */
function send(
	agent: https.Agent,
	opts: { headers: Record<string, string> },
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				agent,
				host: "api.example",
				path: "/user",
				headers: opts.headers,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString(),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

test("a request to a secret's host reaches the host with the real value where the guest put the placeholder", async (t) => {
	const upstream = await upstreamHost(t);
	const { port } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});

	await send(clientThrough(t, port, "api.example:443"), {
		headers: { authorization: `token ${PLACEHOLDER}` },
	});

	assert.equal(upstream.received[0]?.authorization, "token ghp_real_value");
});

test("the host is dialed by the name the CONNECT approved", async (t) => {
	const upstream = await upstreamHost(t);
	const { port } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});

	await send(clientThrough(t, port, "api.example:443"), { headers: {} });

	assert.equal(upstream.received[0]?.servername, "api.example");
});

test("the host's answer reaches the guest intact", async (t) => {
	const upstream = await upstreamHost(t);
	const { port } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});

	const answer = await send(clientThrough(t, port, "api.example:443"), {
		headers: { authorization: `token ${PLACEHOLDER}` },
	});

	assert.equal(answer.status, 200);
	assert.equal(answer.headers["x-upstream"], "yes");
	assert.equal(answer.body, "hello from upstream");
});

test("the guest is shown a certificate for the host from the playpen CA", async (t) => {
	const { port } = await gatekeeperWith(t, { policy: () => secretPolicy() });

	const secure = await tlsOver(
		t,
		await tunnel(port, "api.example:443"),
		"api.example",
	);

	const cert = secure.getPeerX509Certificate();
	assert.equal(cert?.subjectAltName, "DNS:api.example");
	assert.ok(
		cert?.verify(new X509Certificate(playpenCa.certPem).publicKey),
		"not signed by the playpen CA",
	);
});

test("two requests on one kept-alive connection are both sent on, through one tunnel", async (t) => {
	const upstream = await upstreamHost(t);
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});
	const agent = clientThrough(t, port, "api.example:443");

	const first = await send(agent, {
		headers: { authorization: `token ${PLACEHOLDER}` },
	});
	const second = await send(agent, {
		headers: { authorization: `Bearer ${PLACEHOLDER}` },
	});

	assert.deepEqual([first.status, second.status], [200, 200]);
	assert.deepEqual(
		upstream.received.map((r) => r.authorization),
		["token ghp_real_value", "Bearer ghp_real_value"],
	);
	assert.equal(log.filter((e) => e.verdict === "allow").length, 1);
});

test("each request on a kept-alive connection logs its own injection", async (t) => {
	const upstream = await upstreamHost(t);
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});
	const agent = clientThrough(t, port, "api.example:443");

	await send(agent, { headers: { authorization: `token ${PLACEHOLDER}` } });
	await send(agent, { headers: { authorization: `token ${PLACEHOLDER}` } });

	assert.equal(log.filter((e) => e.verdict === "inject").length, 2);
});

test("a TLS server name other than the approved host is refused, and the refusal is logged", async (t) => {
	const upstream = await upstreamHost(t);
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});

	await assert.rejects(
		tlsOver(t, await tunnel(port, "api.example:443"), "other.example"),
	);

	const denied = log.find((e) => e.verdict === "deny");
	assert.match(denied?.reason ?? "", /other\.example is not api\.example/);
	assert.deepEqual(upstream.received, []);
});

test("a tunnel the interceptor declines is piped untouched: the guest sees the host's own certificate, and the host the placeholder", async (t) => {
	const upstream = await upstreamHost(t);
	const { port } = await gatekeeperWith(t, {
		policy: () => secretPolicy([`localhost:${upstream.port}`]),
	});
	// Trusting only the host's own CA, so a certificate from the playpen CA
	// would fail the handshake.
	const agent = clientThrough(t, port, `${HOST_ALIAS}:${upstream.port}`, {
		servername: "api.example",
		ca: publicCa,
	});

	const answer = await send(agent, {
		headers: { authorization: `token ${PLACEHOLDER}` },
	});

	assert.equal(answer.body, "hello from upstream");
	assert.equal(upstream.received[0]?.authorization, `token ${PLACEHOLDER}`);
});

/**
 * What a piped tunnel to a name looks like here: resolution answers
 * 127.0.0.1, which the gatekeeper will not dial, so the tunnel is closed and a
 * second line names the address. An intercepted one would have been answered
 * 200 instead.
 */
async function assertPiped(
	port: number,
	log: LogEntry[],
	target: string,
): Promise<void> {
	await assert.rejects(tunnel(port, target), { message: "closed" });
	assert.deepEqual(
		log.map((e) => e.verdict),
		["allow", "deny"],
	);
	assert.match(log[1]?.reason ?? "", /an address of this machine/);
}

test("a CONNECT to port 80 of a secret's host is piped, since only TLS is intercepted", async (t) => {
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
	});
	await assertPiped(port, log, "api.example:80");
});

test("a subdomain of a secret's host is piped: a secret is for the host it names exactly", async (t) => {
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
	});
	await assertPiped(port, log, "sub.api.example:443");
});

test("a plain HTTP request to port 443 of a secret's host is dialed through the address rules, not intercepted", async (t) => {
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		resolveTo: "127.0.0.1",
	});

	await plainHttpGet(port, "http://api.example:443/");

	const refused = log.find((e) => e.verdict === "deny");
	assert.match(
		refused?.reason ?? "",
		/127\.0\.0\.1, which is an address of this machine/,
	);
});

/** A plain-HTTP GET for `url` through the proxy; resolves with the status. */
function plainHttpGet(proxyPort: number, url: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port: proxyPort, path: url },
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

test("the host is dialed only at an address the gatekeeper's own rules allow", async (t) => {
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		resolveTo: "127.0.0.1",
	});
	const secure = await tlsOver(
		t,
		await tunnel(port, "api.example:443"),
		"api.example",
	);
	const agent = new https.Agent({ keepAlive: false });
	agent.createConnection = () => secure;

	const answer = await send(agent, { headers: {} });

	assert.equal(answer.status, 502);
	const refused = log.find((e) => e.verdict === "deny");
	assert.match(
		refused?.reason ?? "",
		/127\.0\.0\.1, which is an address of this machine/,
	);
	assert.ok(
		log.some((e) => e.verdict === "error"),
		`no error line in ${JSON.stringify(log)}`,
	);
});

test("a request whose dial is refused logs no injection, since the value never left", async (t) => {
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		resolveTo: "127.0.0.1",
	});
	const secure = await tlsOver(
		t,
		await tunnel(port, "api.example:443"),
		"api.example",
	);
	const agent = new https.Agent({ keepAlive: false });
	agent.createConnection = () => secure;

	const answer = await send(agent, {
		headers: { authorization: `token ${PLACEHOLDER}` },
	});

	assert.equal(answer.status, 502);
	assert.deepEqual(
		log.filter((e) => e.verdict === "inject"),
		[],
	);
});

test("a placeholder in a header other than Authorization reaches the host as the guest sent it", async (t) => {
	const upstream = await upstreamHost(t);
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});

	await send(clientThrough(t, port, "api.example:443"), {
		headers: { "x-api-version": PLACEHOLDER },
	});

	assert.deepEqual(headersNamed(upstream.received[0], "x-api-version"), [
		PLACEHOLDER,
	]);
	assert.deepEqual(
		log.filter((e) => e.verdict === "inject"),
		[],
	);
});

test("each injection is logged with the host, the header and the variable, and the log never holds the value", async (t) => {
	const upstream = await upstreamHost(t);
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});

	await send(clientThrough(t, port, "api.example:443"), {
		headers: { authorization: `token ${PLACEHOLDER}` },
	});

	const injected = log.filter((e) => e.verdict === "inject");
	assert.deepEqual(
		injected.map(({ host, port, header, env }) => ({
			host,
			port,
			header,
			env,
		})),
		[
			{
				host: "api.example",
				port: 443,
				header: "authorization",
				env: "GH_TOKEN",
			},
		],
	);
	assert.doesNotMatch(JSON.stringify(log), /ghp_real_value/);
});
