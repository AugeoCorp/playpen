import type { IncomingMessage, ServerResponse } from "node:http";
import https, { type Server } from "node:https";
import type { LookupFunction } from "node:net";
import { type Duplex, pipeline } from "node:stream";
import type tls from "node:tls";
import type { HeldSecret } from "./fence.ts";
import type { LogEntry } from "./gatekeeper.ts";
import type { Header } from "./inject.ts";
import type { ContextFor } from "./leaf.ts";
import { type Policy, parseSecretHost } from "./policy.ts";

/**
 * Called for each allowed `CONNECT` with the policy it was decided on and the
 * lookup the gatekeeper would have dialed it with. Returns the server that
 * takes the tunnel, or undefined to have it piped.
 */
export type Interceptor = (
	policy: Policy,
	target: { host: string; port: number },
	lookup: LookupFunction,
) => Server | undefined;

export interface InterceptorOptions {
	/** The values, which live nowhere but here and the helper's stdin. */
	held: readonly HeldSecret[];
	contextFor: ContextFor;
	log: (line: LogEntry) => void;
	/**
	 * Opens the upstream TLS connection in place of `tls.connect`. For a test,
	 * whose host is a server on its own loopback: the lookup never dials there,
	 * and nothing unprivileged listens on port 443.
	 */
	connect?: (options: tls.ConnectionOptions) => Duplex;
}

/** Only TLS is terminated; any other port on a secret's host is piped. */
const TLS_PORT = 443;

/**
 * Takes a tunnel to port 443 of a host that a held secret's grant names
 * exactly, since a secret is for that host and not for everything under it.
 */
export function interceptor(options: InterceptorOptions): Interceptor {
	return (policy, target, lookup) => {
		if (target.port !== TLS_PORT) return undefined;
		const granted = new Set(
			policy.secrets
				.filter((grant) =>
					grant.hosts.some((host) => parseSecretHost(host) === target.host),
				)
				.map((grant) => grant.env),
		);
		return options.held.some((secret) => granted.has(secret.env))
			? tunnelServer(options, target.host, lookup)
			: undefined;
	};
}

/**
 * Hop-by-hop headers (RFC 9110, 7.6.1), which describe one connection and not
 * the one after it. `Transfer-Encoding` is kept because Node frames the
 * forwarded body by it.
 */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"upgrade",
]);

/**
 * One server per tunnel, never listening: proxy-chain hands it the tunnel's
 * socket as a `connection` once it has answered the `CONNECT`. It terminates
 * TLS for the approved host with a certificate from the install's CA and
 * sends each request on to that host alone, over TLS it verifies, at an
 * address `lookup` allows. Bodies are streamed through unread.
 */
function tunnelServer(
	{ contextFor, log, connect }: InterceptorOptions,
	host: string,
	lookup: LookupFunction,
): Server {
	function logLine(verdict: "deny" | "error", reason: string): void {
		log({
			time: new Date().toISOString(),
			host,
			port: TLS_PORT,
			verdict,
			reason,
		});
	}

	const agent = new https.Agent({ keepAlive: true });
	if (connect !== undefined) {
		agent.createConnection = (options) =>
			connect(options as tls.ConnectionOptions);
	}

	function relay(request: IncomingMessage, response: ServerResponse): void {
		function fail(error: Error): void {
			logLine("error", error.message);
			if (response.headersSent) response.destroy();
			else response.writeHead(502, { connection: "close" }).end();
		}
		const upstream = https.request({
			host,
			port: TLS_PORT,
			servername: host,
			lookup,
			agent,
			method: request.method,
			path: request.url,
			headers: endToEnd(request.rawHeaders).flat(),
		});
		upstream.on("response", (answer) => {
			response.writeHead(
				answer.statusCode ?? 502,
				answer.statusMessage,
				endToEnd(answer.rawHeaders).flat(),
			);
			pipeline(answer, response, (error) => {
				if (error) fail(error);
			});
		});
		upstream.on("error", fail);
		// A failure here reaches `fail` through the upstream's own error.
		pipeline(request, upstream, () => {});
	}

	const server = https.createServer(
		{
			SNICallback(servername, done) {
				if (servername.toLowerCase().replace(/\.$/, "") === host) {
					done(null, contextFor(host));
					return;
				}
				const reason = `TLS server name ${servername} is not ${host}, the host this tunnel was allowed for`;
				logLine("deny", reason);
				done(new Error(reason));
			},
			ALPNProtocols: ["http/1.1"],
			// Node's default, 300 s for the whole request, would cut off a large
			// upload over a slow link.
			requestTimeout: 0,
		},
		relay,
	);
	server.on("connection", (socket: Duplex) => {
		socket.once("close", () => agent.destroy());
	});
	return server;
}

function endToEnd(rawHeaders: readonly string[]): Header[] {
	return headerPairs(rawHeaders).filter(
		([name]) => !HOP_BY_HOP.has(name.toLowerCase()),
	);
}

/** Node reads headers into a flat `[name, value, name, value, …]` list. */
function headerPairs(rawHeaders: readonly string[]): Header[] {
	return rawHeaders.flatMap((name, index) =>
		index % 2 === 0 ? [[name, rawHeaders[index + 1] ?? ""] as Header] : [],
	);
}
