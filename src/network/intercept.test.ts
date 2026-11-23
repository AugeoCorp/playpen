import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type ServerResponse } from "node:http";
import https from "node:https";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, type TestContext, test } from "node:test";
import tls from "node:tls";
import { sleep } from "../time.ts";
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
	await Promise.all(
		dataHomes.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

const GH_TOKEN: HeldSecret = { env: "GH_TOKEN", value: "ghp_real_value" };

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
	headers: http.IncomingHttpHeaders;
	servername: string;
	body: Buffer;
}

/**
 * The real host, as far as these tests go: an HTTPS server with a certificate
 * from `publicCa`, which answers every request with a fixed body and a header
 * of its own, or as `answer` says.
 */
async function upstreamHost(
	t: TestContext,
	answer: (response: ServerResponse) => void = (response) => {
		response.setHeader("x-upstream", "yes");
		response.end("hello from upstream");
	},
): Promise<{ port: number; received: Received[] }> {
	const contextFor = leafMinter(publicCa);
	const received: Received[] = [];
	const server = https.createServer(
		{ SNICallback: (name, done) => done(null, contextFor(name)) },
		(request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				received.push({
					headers: request.headers,
					servername: (request.socket as tls.TLSSocket).servername || "",
					body: Buffer.concat(chunks),
				});
				answer(response);
			});
		},
	);
	t.after(() => server.closeAllConnections());
	return { port: await listening(t, server), received };
}

/** Listens on a free loopback port until the test ends, and returns it. */
async function listening(t: TestContext, server: net.Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	return (server.address() as net.AddressInfo).port;
}

/**
 * A host that answers every request with `statusLine` and a two-byte body,
 * written by hand, so it can send what no Node server would.
 */
function rawHost(t: TestContext, statusLine: string): Promise<number> {
	const contextFor = leafMinter(publicCa);
	const server = tls.createServer(
		{ SNICallback: (name, done) => done(null, contextFor(name)) },
		(socket) => {
			socket.once("data", () =>
				socket.end(`${statusLine}\r\ncontent-length: 2\r\n\r\nok`),
			);
		},
	);
	return listening(t, server);
}

/** The interceptor logs a failed handshake after the client has gone. */
async function lineLogged(
	log: LogEntry[],
	verdict: LogEntry["verdict"],
): Promise<void> {
	while (!log.some((line) => line.verdict === verdict)) await sleep(10);
}

/**
 * The gatekeeper as the helper runs it, holding GH_TOKEN, with every line it
 * logs collected. Every name resolves to 127.0.0.1, which the gatekeeper will
 * not dial, so with `upstreamPort` the interceptor's connection to the
 * approved host is sent to the test's own server instead, trusting
 * `upstreamCa` there.
 */
async function gatekeeperWith(
	t: TestContext,
	options: {
		policy: () => Policy;
		held?: readonly HeldSecret[];
		upstreamPort?: number;
		upstreamCa?: Ca;
	},
): Promise<{ port: number; log: LogEntry[] }> {
	const log: LogEntry[] = [];
	const { upstreamPort: port, upstreamCa = publicCa } = options;
	const gatekeeper = await startGatekeeper({
		policy: options.policy,
		log: (line) => log.push(line),
		resolve: async () => [{ address: "127.0.0.1", family: 4 }],
		intercept: interceptor({
			held: options.held ?? [GH_TOKEN],
			contextFor: leafMinter(playpenCa),
			log: (line) => log.push(line),
			...(port === undefined
				? {}
				: {
						connect: (dial: tls.ConnectionOptions) =>
							tls.connect({
								...dial,
								host: "127.0.0.1",
								port,
								ca: upstreamCa.certPem,
							}),
					}),
		}),
	});
	t.after(() => gatekeeper.close());
	return { port: gatekeeper.port, log };
}

/**
 * Sends a CONNECT and resolves with the tunnel once it is answered 200, or
 * rejects with the status line, or "closed" if the proxy hung up instead.
 */
function tunnel(proxyPort: number, target: string): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(proxyPort, "127.0.0.1");
		function refuse(why: string): void {
			socket.destroy();
			reject(new Error(why));
		}
		socket.once("connect", () =>
			socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
		);
		socket.once("data", (chunk: Buffer) => {
			const status = chunk.toString("latin1").split("\r\n")[0] ?? "";
			if (/ 200 /.test(status)) resolve(socket);
			else refuse(status);
		});
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

/** An HTTPS client whose every connection is a fresh tunnel through the gatekeeper. */
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
				(error: Error) => done?.(error, undefined as never),
			);
		return undefined;
	};
	t.after(() => agent.destroy());
	return agent;
}

interface Answer {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

/** One request to `api.example` over `agent`; a `body` goes out chunked. */
function send(
	agent: https.Agent,
	request: {
		headers?: Record<string, string>;
		method?: string;
		body?: Buffer;
	} = {},
): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const outgoing = https.request(
			{
				agent,
				host: "api.example",
				path: "/user",
				method: request.method ?? "GET",
				headers: request.headers ?? {},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("error", reject);
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString(),
					}),
				);
			},
		);
		outgoing.on("error", reject);
		if (request.body !== undefined) outgoing.write(request.body);
		outgoing.end();
	});
}

test("a TLS server name other than the approved host is refused, and the refusal is logged", async (t) => {
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
	});

	await assert.rejects(
		tunnel(port, "api.example:443").then((socket) =>
			tlsOver(t, socket, "other.example"),
		),
	);

	assert.deepEqual(
		log.map((line) => [line.verdict, line.reason]),
		[
			["allow", log[0]?.reason],
			[
				"deny",
				"TLS server name other.example is not api.example, the host this tunnel was allowed for",
			],
		],
	);
});

test("the TLS server name is matched whatever its case, and with a trailing dot", async (t) => {
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
	});

	await tlsOver(t, await tunnel(port, "api.example:443"), "API.Example.");

	assert.deepEqual(
		log.map((line) => line.verdict),
		["allow"],
	);
});

test("a guest that does not trust the playpen CA leaves an error line saying so", async (t) => {
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
	});
	const dir = await mkdtemp(join(tmpdir(), "playpen-distrust-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "ca.crt"), publicCa.certPem);

	// openssl, as curl and Python do, verifies inside the handshake and says
	// why it stopped; Node's own client only hangs up.
	const openssl = spawn(
		"openssl",
		[
			"s_client",
			"-proxy",
			`127.0.0.1:${port}`,
			"-connect",
			"api.example:443",
			"-servername",
			"api.example",
			"-CAfile",
			join(dir, "ca.crt"),
			"-verify_return_error",
		],
		{ stdio: "ignore" },
	);
	await lineLogged(log, "error");
	openssl.kill();

	assert.deepEqual(
		log.map((line) => [line.verdict, line.reason]),
		[
			["allow", log[0]?.reason],
			["error", "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA"],
		],
	);
});

test("a request reaches the host, and the host's answer reaches the guest intact", async (t) => {
	const upstream = await upstreamHost(t);
	const { port } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});

	const answer = await send(clientThrough(t, port, "api.example:443"), {
		headers: { accept: "application/json" },
	});

	assert.equal(upstream.received[0]?.headers.accept, "application/json");
	assert.equal(answer.status, 200);
	assert.equal(answer.headers["x-upstream"], "yes");
	assert.equal(answer.body, "hello from upstream");
});

test("the host is dialed by the name the CONNECT approved", async (t) => {
	const upstream = await upstreamHost(t);
	const { port } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});

	await send(clientThrough(t, port, "api.example:443"));

	assert.equal(upstream.received[0]?.servername, "api.example");
});

test("the host is dialed only at an address the gatekeeper's own rules allow", async (t) => {
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
	});

	const answer = await send(clientThrough(t, port, "api.example:443"));

	assert.equal(answer.status, 502);
	assert.match(
		log.find((line) => line.verdict === "deny")?.reason ?? "",
		/127\.0\.0\.1, which is an address of this machine/,
	);
});

test("a host whose certificate fails verification gets nothing, and the guest a 502 and an error line, whatever the user's shell says", async (t) => {
	const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	t.after(() => {
		if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
	});
	const upstream = await upstreamHost(t);
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
		// The host's certificate is from publicCa, so this check fails.
		upstreamCa: playpenCa,
	});

	const answer = await send(clientThrough(t, port, "api.example:443"));

	assert.equal(answer.status, 502);
	assert.deepEqual(upstream.received, []);
	assert.deepEqual(
		log.map((line) => line.verdict),
		["allow", "error"],
	);
});

test("a reason phrase holding a control byte is not passed on, and the guest still gets the answer", async (t) => {
	const { port } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: await rawHost(t, "HTTP/1.1 200 O\x01K"),
	});

	const answer = await send(clientThrough(t, port, "api.example:443"));
	const next = await send(clientThrough(t, port, "api.example:443"));

	assert.deepEqual([answer.status, answer.body], [200, "ok"]);
	assert.equal(next.status, 200, "the next tunnel was not served");
});

test("a host hanging up partway through its answer ends the guest's response with an error, and the next request is served", async (t) => {
	let hangUp = true;
	const upstream = await upstreamHost(t, (response) => {
		if (!hangUp) {
			response.end("hello from upstream");
			return;
		}
		hangUp = false;
		response.writeHead(200, { "content-length": "1000000" });
		response.write(Buffer.alloc(10_000), () => response.destroy());
	});
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});

	await assert.rejects(send(clientThrough(t, port, "api.example:443")));
	const next = await send(clientThrough(t, port, "api.example:443"));

	assert.equal(next.body, "hello from upstream");
	assert.equal(log.filter((line) => line.verdict === "error").length, 1);
});

test("a 3 MB chunked upload arrives at the host byte for byte", async (t) => {
	const upstream = await upstreamHost(t);
	const { port } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});
	const upload = Buffer.alloc(3 * 1024 * 1024, "0123456789abcdef");

	const answer = await send(clientThrough(t, port, "api.example:443"), {
		method: "POST",
		body: upload,
	});

	assert.equal(answer.status, 200);
	const received = upstream.received[0];
	assert.equal(received?.headers["transfer-encoding"], "chunked");
	assert.ok(received?.body.equals(upload), "the body arrived changed");
});

test("the guest's hop-by-hop headers do not reach the host, so an upgrade request arrives as a plain one", async (t) => {
	const upstream = await upstreamHost(t);
	const { port } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});

	const answer = await send(clientThrough(t, port, "api.example:443"), {
		headers: {
			connection: "Upgrade",
			upgrade: "websocket",
			te: "trailers",
			"proxy-authorization": "Basic Zm9vOmJhcg==",
		},
	});

	assert.equal(answer.status, 200);
	const { connection, ...sent } = upstream.received[0]?.headers ?? {};
	assert.deepEqual(sent, { host: "api.example" });
	assert.notEqual(connection, "Upgrade");
});

test("the host's hop-by-hop headers do not reach the guest", async (t) => {
	const upstream = await upstreamHost(t, (response) => {
		response.setHeader("upgrade", "h2c");
		response.setHeader("proxy-connection", "keep-alive");
		response.end("hello from upstream");
	});
	const { port } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		upstreamPort: upstream.port,
	});

	const answer = await send(clientThrough(t, port, "api.example:443"));

	assert.equal(answer.headers.upgrade, undefined);
	assert.equal(answer.headers["proxy-connection"], undefined);
});

test("a tunnel for a host no held secret names is piped untouched, and the guest sees the host's own certificate", async (t) => {
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

	const answer = await send(agent);

	assert.equal(answer.body, "hello from upstream");
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
		log.map((line) => line.verdict),
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

test("a secret's host is piped when the helper does not hold the secret", async (t) => {
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
		held: [],
	});
	await assertPiped(port, log, "api.example:443");
});

test("a secret dropped from the policy is no longer intercepted for on the next tunnel", async (t) => {
	let policy = secretPolicy();
	const { port, log } = await gatekeeperWith(t, { policy: () => policy });
	(await tunnel(port, "api.example:443")).destroy();

	policy = { ...secretPolicy(), secrets: [] };
	log.length = 0;

	await assertPiped(port, log, "api.example:443");
});

test("a plain HTTP request to port 443 of a secret's host is dialed through the address rules, not intercepted", async (t) => {
	const { port, log } = await gatekeeperWith(t, {
		policy: () => secretPolicy(),
	});

	await new Promise<void>((resolve, reject) => {
		http
			.get(
				{ host: "127.0.0.1", port, path: "http://api.example:443/" },
				(response) => {
					response.resume();
					response.on("end", resolve);
				},
			)
			.on("error", reject);
	});

	assert.match(
		log.find((line) => line.verdict === "deny")?.reason ?? "",
		/127\.0\.0\.1, which is an address of this machine/,
	);
});
