import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:https";
import https from "node:https";
import type { LookupFunction, Socket } from "node:net";
import type { Duplex } from "node:stream";
import type tls from "node:tls";
import type { HeldSecret } from "./fence.ts";
import type { LogEntry } from "./gatekeeper.ts";
import type { ContextFor } from "./leaf.ts";
import { type Policy, parseSecretHost } from "./policy.ts";

/**
 * How a held secret's host is reached: for a `CONNECT` to a host the secret
 * names, TLS is terminated here with a certificate from the install's CA, and
 * each request goes on over a fresh TLS connection to that same host. Bodies
 * are streamed through unread. Everything else the gatekeeper pipes untouched.
 */

export interface Target {
	host: string;
	port: number;
}

/**
 * Called for each allowed `CONNECT` with the policy it was decided on and the
 * lookup the gatekeeper would have dialed it with. Returns the server that
 * takes the tunnel, or null to have it piped.
 */
export type Interceptor = (
	policy: Policy,
	target: Target,
	lookup: LookupFunction,
) => Server | null;

export interface InterceptorOptions {
	/** The values, which live nowhere but here and the helper's stdin. */
	held: readonly HeldSecret[];
	contextFor: ContextFor;
	log: (line: LogEntry) => void;
	/**
	 * Opens the upstream TLS connection; `tls.connect` unless a test has to
	 * reach a server on its own loopback, which the lookup never dials.
	 */
	connect?: (options: tls.ConnectionOptions) => Duplex;
}

/** Only TLS is terminated; any other port on a secret host is piped. */
const TLS_PORT = 443;

/**
 * The variables `policy` lets go to `host`: an exact match on a name its
 * `secrets` lists, since a secret is meant for that host and not for
 * everything under it.
 */
function grantedTo(policy: Policy, host: string): Set<string> {
	return new Set(
		policy.secrets
			.filter((grant) => grant.hosts.some((h) => parseSecretHost(h) === host))
			.map((grant) => grant.env),
	);
}

export function interceptor(opts: InterceptorOptions): Interceptor {
	return (policy, target, lookup) => {
		if (target.port !== TLS_PORT) return null;
		const granted = grantedTo(policy, target.host);
		if (!opts.held.some((secret) => granted.has(secret.env))) return null;
		return tunnelServer(opts, target, lookup);
	};
}

/**
 * One server per tunnel, never listening: proxy-chain hands it the tunnel's
 * socket as a `connection` once it has answered the `CONNECT`. It is built for
 * one approved host, dials only that host, and serves only a client that
 * names that host in its server name.
 */
function tunnelServer(
	opts: InterceptorOptions,
	{ host, port }: Target,
	lookup: LookupFunction,
): Server {
	const { contextFor, log } = opts;
	const at = () => ({ time: new Date().toISOString(), host, port });
	const logError = (err: unknown) =>
		log({
			...at(),
			verdict: "error",
			reason: err instanceof Error ? err.message : String(err),
		});

	const agent = new https.Agent({ keepAlive: true });
	const connect = opts.connect;
	if (connect !== undefined)
		agent.createConnection = (o) => connect(o as tls.ConnectionOptions);

	const upstream = (req: IncomingMessage) =>
		https.request({
			host,
			port,
			servername: host,
			lookup,
			agent,
			method: req.method,
			path: req.url,
			headers: req.rawHeaders,
		});

	let refusedName = false;
	const server = https.createServer({
		SNICallback: (servername, done) => {
			if (servername.toLowerCase().replace(/\.$/, "") === host) {
				done(null, contextFor(host));
				return;
			}
			refusedName = true;
			const reason = `TLS server name ${servername} is not ${host}, the host this tunnel was allowed for`;
			log({ ...at(), verdict: "deny", reason });
			done(new Error(reason));
		},
		ALPNProtocols: ["http/1.1"],
	});

	server.on("connection", (socket: Socket) => {
		socket.once("close", () => agent.destroy());
	});
	server.on("tlsClientError", (err: NodeJS.ErrnoException) => {
		if (!refusedName && err.code !== "ECONNRESET") logError(err);
	});

	server.on("request", (req: IncomingMessage, res: ServerResponse) => {
		const up = upstream(req);
		up.on("response", (answer) => {
			res.writeHead(
				answer.statusCode ?? 502,
				answer.statusMessage,
				answer.rawHeaders,
			);
			answer.pipe(res);
		});
		up.on("error", (err) => {
			logError(err);
			if (res.headersSent) res.destroy();
			else res.writeHead(502, { connection: "close" }).end();
		});
		req.pipe(up);
	});

	return server;
}
