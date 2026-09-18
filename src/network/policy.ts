/**
 * Pure allow/deny policy for outbound guest connections. No I/O: the
 * gatekeeper (gatekeeper.ts) owns the proxy-chain server and calls `decide`
 * once per CONNECT or plain HTTP request.
 */

export const HOST_ALIAS = "host.playpen.internal";

/**
 * The name the fence's own liveness check asks for. A request for it proves
 * the guest's route to the gatekeeper is carrying traffic and nothing else:
 * it is answered from here, never dialed, so it needs no allow entry and
 * reaches no host.
 */
export const PROBE_HOST = "probe.playpen.internal";

/**
 * A guess, not a measurement: the hosts Claude Code and common package
 * managers seem likely to need. Provisional until a `mode: "log"` run of
 * Claude Code against real projects replaces it with the hosts actually
 * reached.
 */
export const BUILTIN_ALLOW: readonly string[] = [
	"api.anthropic.com",
	"statsig.anthropic.com",
	"registry.npmjs.org",
	"nodejs.org",
	"github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
	"pypi.org",
	"files.pythonhosted.org",
];

export interface Policy {
	/** Built-in entries plus the project's `network.allow`, already merged. */
	allow: readonly string[];
	mode: "enforce" | "log";
}

export type Verdict =
	| { kind: "allow"; target: { host: string; port: number }; reason: string }
	| { kind: "deny"; reason: string }
	| { kind: "probe"; reason: string }
	| { kind: "report"; target: { host: string; port: number }; reason: string };

type Entry =
	| { kind: "host"; host: string; port: number | null; raw: string }
	| { kind: "ip"; host: string; port: number | null; raw: string }
	| { kind: "local"; port: number; raw: string };

function isValidPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isIpv4(host: string): boolean {
	const octets = host.split(".");
	return (
		octets.length === 4 &&
		octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
	);
}

function isHostname(host: string): boolean {
	const labels = host.split(".");
	return (
		host.length <= 253 &&
		labels.length > 1 &&
		labels.every(
			(label) =>
				/^[a-z0-9-]+$/.test(label) &&
				!label.startsWith("-") &&
				!label.endsWith("-"),
		)
	);
}

function normalizeRequestHost(hostname: string): string | null {
	const host = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (host === "" || (!isHostname(host) && !isIpv4(host))) return null;
	return host;
}

/** A malformed entry is dropped rather than matched, so a policy assembled
 * from bad input denies instead of surprising. */
function parseEntry(raw: string): Entry | null {
	const entry = raw.trim().toLowerCase().replace(/\.$/, "");
	const colon = entry.lastIndexOf(":");
	const hostPart = colon === -1 ? entry : entry.slice(0, colon);
	const portPart = colon === -1 ? null : entry.slice(colon + 1);

	let port: number | null = null;
	if (portPart !== null) {
		if (!/^\d{1,5}$/.test(portPart)) return null;
		port = Number(portPart);
		if (!isValidPort(port)) return null;
	}

	if (hostPart === "localhost") {
		return port === null ? null : { kind: "local", port, raw };
	}
	if (isIpv4(hostPart)) return { kind: "ip", host: hostPart, port, raw };
	if (isHostname(hostPart)) return { kind: "host", host: hostPart, port, raw };
	return null;
}

function matchesHost(entry: Extract<Entry, { kind: "host" }>, host: string) {
	return host === entry.host || host.endsWith(`.${entry.host}`);
}

function decideTarget(
	policy: Policy,
	hostname: string,
	port: number,
): {
	allowed: boolean;
	target: { host: string; port: number };
	reason: string;
	/** Refused in every mode: log mode opens the internet, never this machine. */
	final?: true;
	probe?: true;
} {
	const entries = policy.allow
		.map(parseEntry)
		.filter((e): e is Entry => e !== null);

	const host = normalizeRequestHost(hostname);
	if (host === null || !isValidPort(port)) {
		return {
			allowed: false,
			final: true,
			target: { host: hostname, port },
			reason: `cannot parse host "${hostname}" or port ${port}`,
		};
	}

	if (host === PROBE_HOST) {
		return {
			allowed: false,
			probe: true,
			target: { host, port },
			reason: `${PROBE_HOST} is the fence's own liveness check; nothing is dialed`,
		};
	}

	if (host === HOST_ALIAS) {
		const local = entries.find((e) => e.kind === "local" && e.port === port);
		return local
			? {
					allowed: true,
					target: { host: "127.0.0.1", port },
					reason: `${HOST_ALIAS}:${port} maps to 127.0.0.1 via a localhost:${port} entry`,
				}
			: {
					allowed: false,
					final: true,
					target: { host: "127.0.0.1", port },
					reason: `${HOST_ALIAS}:${port} has no matching localhost:${port} entry`,
				};
	}

	// The guest's own loopback never reaches this proxy; a CONNECT naming it
	// literally is the guest asking for the *host's* loopback, which is only
	// reachable through the alias above.
	if (host === "localhost" || host === "127.0.0.1") {
		return {
			allowed: false,
			final: true,
			target: { host, port },
			reason: `${host} is refused; use ${HOST_ALIAS} to reach the host's loopback`,
		};
	}

	if (isIpv4(host)) {
		const matched = entries.find(
			(e) =>
				e.kind === "ip" &&
				e.host === host &&
				(e.port === null || e.port === port),
		);
		return matched
			? {
					allowed: true,
					target: { host, port },
					reason: `ip literal ${host} is explicitly allowed`,
				}
			: {
					allowed: false,
					target: { host, port },
					reason: `ip literal ${host} is not in the allow list`,
				};
	}

	const matched = entries.find(
		(e) =>
			e.kind === "host" &&
			matchesHost(e, host) &&
			(e.port === null || e.port === port),
	);
	return matched
		? {
				allowed: true,
				target: { host, port },
				reason: `matches allow entry "${matched.raw}"`,
			}
		: {
				allowed: false,
				target: { host, port },
				reason: `${host} is not in the allow list`,
			};
}

export function decide(
	policy: Policy,
	hostname: string,
	port: number,
): Verdict {
	const { allowed, target, reason, final, probe } = decideTarget(
		policy,
		hostname,
		port,
	);
	if (probe) return { kind: "probe", reason };
	if (allowed) return { kind: "allow", target, reason };
	if (policy.mode === "log" && !final)
		return { kind: "report", target, reason };
	return { kind: "deny", reason };
}
