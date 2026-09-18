import dns from "node:dns";
import { appendFile } from "node:fs/promises";
import type {
	PrepareRequestFunctionOpts,
	PrepareRequestFunctionResult,
} from "proxy-chain";
import { RequestError, Server } from "proxy-chain";
import { isGlobalIpv4, isIpv4 } from "./names.ts";
import type { Policy } from "./policy.ts";
import { decide } from "./policy.ts";

export interface Gatekeeper {
	port: number;
	close(): Promise<void>;
}

export interface LogEntry {
	time: string;
	host: string;
	port: number;
	verdict: "allow" | "deny" | "probe" | "report";
	reason: string;
}

/**
 * What a hostname resolves to. Injectable so a test can decide what a name
 * answers with; the default asks the system resolver.
 */
export type Resolve = (host: string) => Promise<dns.LookupAddress[]>;

export interface StartGatekeeperOptions {
	policy: Policy;
	/** Listen port. Defaults to 0, letting the OS assign one. */
	port?: number;
	log: (line: LogEntry) => void;
	resolve?: Resolve;
}

/**
 * Node's `net.connect` always calls a custom `lookup` hook with
 * `{ all: true }` (see the Socket implementation in `lib/net.js`), so the
 * callback must take an address array even though the two-argument
 * `dns.lookup` overloads never require one. proxy-chain types `dnsLookup` as
 * the full overloaded `dns.lookup`; the hooks here implement only the shape
 * they are actually called with and are cast to match.
 */
function lookupAt(address: string): typeof dns.lookup {
	const lookup = (
		_hostname: string,
		options: dns.LookupOptions,
		callback: (
			err: NodeJS.ErrnoException | null,
			address: string | dns.LookupAddress[],
			family?: number,
		) => void,
	): void => {
		if (options.all) {
			callback(null, [{ address, family: 4 }]);
			return;
		}
		callback(null, address, 4);
	};
	return lookup as typeof dns.lookup;
}

const systemResolver: Resolve = (host) =>
	dns.promises.lookup(host, { all: true });

/**
 * Resolves `host` and hands `net.connect` only the addresses the policy would
 * have allowed as literals, so a name cannot be the way to an address a
 * request for it would have been refused. IPv6 is left out entirely: the fence
 * has no answer for it yet, so a name with only AAAA records fails here.
 *
 * Failing the lookup is what refuses the connection -- proxy-chain closes the
 * tunnel rather than answering it -- so the refusal is logged from in here.
 * The verdict line for this connection has already been written by then.
 */
function lookupGlobal(
	host: string,
	port: number,
	resolve: Resolve,
	log: (line: LogEntry) => void,
): typeof dns.lookup {
	const refuse = (reason: string): Error => {
		log({
			time: new Date().toISOString(),
			host,
			port,
			verdict: "deny",
			reason,
		});
		return new Error(`playpen gatekeeper: ${reason}`);
	};

	const lookup = (
		_hostname: string,
		options: dns.LookupOptions,
		callback: (
			err: NodeJS.ErrnoException | null,
			address: string | dns.LookupAddress[],
			family?: number,
		) => void,
	): void => {
		resolve(host).then(
			(addresses) => {
				const global = addresses.filter(
					(a) => a.family === 4 && isGlobalIpv4(a.address),
				);
				const first = global[0];
				if (first === undefined) {
					const found = addresses.map((a) => a.address).join(", ");
					callback(
						refuse(
							`${host} resolves to ${found === "" ? "no IPv4 address" : found}, which is not a public address`,
						),
						[],
					);
					return;
				}
				if (options.all) callback(null, global);
				else callback(null, first.address, 4);
			},
			(err: unknown) => {
				callback(refuse(`${host} could not be resolved: ${err}`), []);
			},
		);
	};
	return lookup as typeof dns.lookup;
}

/** Starts the CONNECT-gating proxy. Every outbound guest connection arrives
 * here as an HTTP CONNECT; `policy` decides whether it is piped through,
 * refused with a 403 before any upstream socket opens, or (in `"log"` mode)
 * piped through and recorded as what would have been refused. A request for
 * `PROBE_HOST` is refused the same way, and its log line is what tells the
 * helper the guest's route reaches here at all. */
export async function startGatekeeper(
	opts: StartGatekeeperOptions,
): Promise<Gatekeeper> {
	const { policy, log } = opts;
	const resolve = opts.resolve ?? systemResolver;

	const server = new Server({
		port: opts.port ?? 0,
		// Reached only over loopback -- from the fence's relay, never from the
		// network -- so it is never published on one.
		host: "127.0.0.1",
		prepareRequestFunction: ({
			hostname,
			port,
		}: PrepareRequestFunctionOpts): PrepareRequestFunctionResult => {
			const verdict = decide(policy, hostname, port);
			log({
				time: new Date().toISOString(),
				host: hostname,
				port,
				verdict: verdict.kind,
				reason: verdict.reason,
			});

			if (verdict.kind === "deny" || verdict.kind === "probe") {
				throw new RequestError(`playpen gatekeeper: ${verdict.reason}`, 403);
			}
			// The target's host, not the one the request spelled: the two differ in
			// case, in a trailing dot, and wherever the policy mapped the name to an
			// address of its own.
			const target = verdict.target;
			if (isIpv4(target.host)) return { dnsLookup: lookupAt(target.host) };
			return {
				dnsLookup: lookupGlobal(target.host, target.port, resolve, log),
			};
		},
	});

	await server.listen();
	return {
		port: server.port,
		close: () => server.close(true),
	};
}

export async function appendJsonLine(
	path: string,
	entry: LogEntry,
): Promise<void> {
	await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}
