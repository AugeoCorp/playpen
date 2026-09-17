import type dns from "node:dns";
import { appendFile } from "node:fs/promises";
import type {
	PrepareRequestFunctionOpts,
	PrepareRequestFunctionResult,
} from "proxy-chain";
import { RequestError, Server } from "proxy-chain";
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
	verdict: "allow" | "deny" | "report";
	reason: string;
}

export interface StartGatekeeperOptions {
	policy: Policy;
	/** Listen port. Defaults to 0, letting the OS assign one. */
	port?: number;
	log: (line: LogEntry) => void;
}

/**
 * Node's `net.connect` always calls a custom `lookup` hook with
 * `{ all: true }` (see the Socket implementation in `lib/net.js`), so the
 * callback must take an address array even though the two-argument
 * `dns.lookup` overloads never require one. proxy-chain types `dnsLookup` as
 * the full overloaded `dns.lookup`; this implements only the shape it is
 * actually called with and is cast to match.
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

/** Starts the CONNECT-gating proxy. Every outbound guest connection arrives
 * here as an HTTP CONNECT; `policy` decides whether it is piped through,
 * refused with a 403 before any upstream socket opens, or (in `"log"` mode)
 * piped through and recorded as what would have been refused. */
export async function startGatekeeper(
	opts: StartGatekeeperOptions,
): Promise<Gatekeeper> {
	const { policy, log } = opts;

	const server = new Server({
		port: opts.port ?? 0,
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

			if (verdict.kind === "deny") {
				throw new RequestError(`playpen gatekeeper: ${verdict.reason}`, 403);
			}
			if (verdict.target.host === hostname) return {};
			return { dnsLookup: lookupAt(verdict.target.host) };
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
