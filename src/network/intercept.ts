import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:https";
import https from "node:https";
import type { LookupFunction, Socket } from "node:net";
import type { Duplex } from "node:stream";
import type tls from "node:tls";
import type { HeldSecret } from "./fence.ts";
import type { LogEntry } from "./gatekeeper.ts";
import { rewriteHeaders } from "./inject.ts";
import type { ContextFor } from "./leaf.ts";
import { type Policy, parseSecretHost } from "./policy.ts";

/**
 * Where a held secret's value goes into requests: for a `CONNECT` to a host
 * the secret names, TLS is terminated here with a certificate from the
 * install's CA, each request's headers get the real value in place of the
 * placeholder, and the request goes on over a fresh TLS connection to that
 * same host. Bodies are streamed through unread. Everything else the
 * gatekeeper pipes untouched.
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
 * Hop-by-hop headers (after RFC 9110, 7.6.1), which describe the guest's
 * connection to here, not this one's to the host. `Transfer-Encoding` is kept
 * because Node frames the forwarded body by it.
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

/** Headers a front end may route a request by, rather than by its connection. */
const ROUTING = new Set([
	"host",
	"x-forwarded-host",
	"forwarded",
	"x-original-url",
	"x-rewrite-url",
	"x-host",
	"x-http-host-override",
	"x-forwarded-server",
]);

/**
 * A TRACE answer echoes the request as the host received it (RFC 9110,
 * 9.3.8), `Authorization` and the value in it included. TRACK is IIS's name
 * for the same; Node's parser rejects it before it gets here today.
 */
const ECHOING = new Set(["TRACE", "TRACK"]);

function withoutHopByHop(raw: readonly string[]): string[] {
	const kept: string[] = [];
	for (let i = 0; i + 1 < raw.length; i += 2) {
		const name = raw[i] as string;
		if (HOP_BY_HOP.has(name.toLowerCase())) continue;
		kept.push(name, raw[i + 1] as string);
	}
	return kept;
}

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
		const secrets = opts.held.filter((secret) => granted.has(secret.env));
		if (secrets.length === 0) return null;
		return tunnelServer(opts, target, secrets, lookup);
	};
}

/**
 * One server per tunnel, never listening: proxy-chain hands it the tunnel's
 * socket as a `connection` once it has answered the `CONNECT`. It is built for
 * one approved host, dials only that host, and serves only a client that
 * names that host in its server name and its `Host` header.
 */
function tunnelServer(
	opts: InterceptorOptions,
	{ host, port }: Target,
	secrets: readonly HeldSecret[],
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

	/**
	 * A request naming another site is refused, not sent on: behind a shared
	 * front end, the request line or `Host` rather than the connection can
	 * decide which site gets the request, and with it the value. An
	 * absolute-form target (`GET https://other.example/`) overrides `Host`
	 * (RFC 9112, 3.2.2), so only a path, or `*` for `OPTIONS`, is accepted; and
	 * not a path starting `//`, which a URL parser reads as naming a host.
	 */
	const misdirection = (req: IncomingMessage): string | null => {
		const target = req.url ?? "";
		if (target.startsWith("//")) {
			return `request target ${target} starts with //, which reads as another host than ${host}, the host this tunnel was allowed for`;
		}
		const originForm =
			target.startsWith("/") || (target === "*" && req.method === "OPTIONS");
		if (!originForm) {
			return `request target ${target} is not a path on ${host}, the host this tunnel was allowed for`;
		}
		const named = (req.headers.host ?? "")
			.toLowerCase()
			.replace(/:443$/, "")
			.replace(/\.$/, "");
		if (named === host) return null;
		return `Host header ${req.headers.host ?? "(none)"} is not ${host}, the host this tunnel was allowed for`;
	};
	/** Why `req` must not be sent on, and the status the guest gets instead. */
	const refusalOf = (
		req: IncomingMessage,
	): { status: 405 | 421; reason: string } | null => {
		const method = req.method ?? "";
		if (ECHOING.has(method)) {
			return {
				status: 405,
				reason: `method ${method} echoes the request back, and the value with it`,
			};
		}
		const reason = misdirection(req);
		return reason === null ? null : { status: 421, reason };
	};
	const refuse = (req: IncomingMessage) => {
		const refusal = refusalOf(req);
		if (refusal !== null) {
			log({ ...at(), verdict: "deny", reason: refusal.reason });
		}
		return refusal;
	};

	/**
	 * The upstream sees one `Host`, the approved one, whatever the guest sent:
	 * Node checks only the first of several, and a front end may route on the
	 * last, or on a header that overrides it.
	 */
	const forwardedHeaders = (req: IncomingMessage) => {
		const kept = withoutHopByHop(req.rawHeaders);
		const headers = ["Host", host];
		for (let i = 0; i + 1 < kept.length; i += 2) {
			const name = kept[i] as string;
			if (ROUTING.has(name.toLowerCase())) continue;
			headers.push(name, kept[i + 1] as string);
		}
		return headers;
	};

	const upstream = (req: IncomingMessage) => {
		const { headers, injected } = rewriteHeaders(
			forwardedHeaders(req),
			secrets,
		);
		const logInjected = () => {
			for (const { header, env } of injected) {
				log({
					...at(),
					verdict: "inject",
					header,
					env,
					reason: `${env} in ${header}`,
				});
			}
		};
		const request = https.request({
			host,
			port,
			servername: host,
			lookup,
			agent,
			method: req.method,
			path: req.url,
			headers,
		});
		// Logged once the connection to the host is up, which is when the value
		// leaves: a dial the address rules refuse, or a certificate that fails,
		// sends nothing. A kept-alive connection is up already.
		request.once("socket", (socket) => {
			if (socket.connecting) socket.once("secureConnect", logInjected);
			else logInjected();
		});
		return request;
	};

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
		const refusal = refuse(req);
		if (refusal !== null) {
			res.writeHead(refusal.status, { connection: "close" }).end();
			return;
		}
		const up = upstream(req);
		up.on("response", (answer) => {
			res.writeHead(
				answer.statusCode ?? 502,
				answer.statusMessage,
				withoutHopByHop(answer.rawHeaders),
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
