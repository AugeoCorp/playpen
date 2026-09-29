import {
	isHostname,
	isIpv4,
	isLanIpv4,
	isPort,
	isPublicIpv4,
} from "./names.ts";

/**
 * Pure allow/deny policy for outbound guest connections. No I/O: the
 * gatekeeper (gatekeeper.ts) owns the proxy-chain server and calls `decide`
 * once per CONNECT or plain HTTP request.
 */
export const HOST_ALIAS = "host.playpen.internal";

/** The fence's own names all end here; none of them is a host on the internet. */
export const FENCE_DOMAIN = ".playpen.internal";

/**
 * The name the fence's own liveness check asks for. A request for it proves
 * the guest's route to the gatekeeper is carrying traffic and nothing else:
 * it is answered from here, never dialed, so it needs no allow entry and
 * reaches no host.
 */
export const PROBE_HOST = "probe.playpen.internal";

/**
 * The other half of the fence's own check: a name no policy can allow, so a
 * guest request for it must come back refused. Its `deny` line in the log is
 * what proves the gatekeeper refuses anything at all.
 */
export const DENY_HOST = "deny.playpen.internal";

/**
 * What to say when the fence is up but the guest cannot reach the gatekeeper
 * through it -- printed by both the helper, while it waits for the guest, and
 * `playpen start`, which would otherwise repeat the same advice on its own.
 */
export const NO_EGRESS_ADVICE: readonly string[] = [
	"the guest cannot reach the gatekeeper through its fence",
	"check its side: playpen run -- systemctl status playpen-tun2proxy",
];

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

/** A port on this machine that the guest also reaches at its own loopback. */
export interface PortForward {
	host: number;
	guest: number;
}

/**
 * A credential from this machine's environment that the sandbox may use on
 * `hosts`. Names only: the value is read where it is used, never written to
 * the policy.
 */
export interface SecretGrant {
	env: string;
	hosts: readonly string[];
}

export interface Policy {
	/**
	 * Built-in entries plus the project's `network.allow`, already merged, a
	 * `localhost:<host>` for each of `ports`, and every host of `secrets`.
	 */
	allow: readonly string[];
	mode: "enforce" | "log";
	/**
	 * For the helper, which listens on the guest's `127.0.0.1:<guest>` and
	 * sends each connection on as a request for `HOST_ALIAS:<host>`. `decide`
	 * never reads it: that request is allowed by the `localhost:<host>` entry
	 * in `allow` like any other, so a port is never a second way through.
	 */
	ports: readonly PortForward[];
	/**
	 * For the interceptor (intercept.ts), which puts the values in. `decide`
	 * never reads it: a secret's host is reachable only because `allow` names
	 * it too.
	 */
	secrets: readonly SecretGrant[];
}

/**
 * What the matched entry permits a resolved name to dial: `"public"` for a
 * port-less entry, `"lan"` (public or a LAN address) for one with a port.
 * Neither is this machine; see `isPublicOrLanIpv4` in names.ts.
 */
export type Reach = "public" | "lan";

export type Verdict =
	| {
			kind: "allow";
			target: { host: string; port: number };
			reach: Reach;
			reason: string;
	  }
	| { kind: "deny"; reason: string }
	| { kind: "probe"; reason: string }
	| {
			kind: "report";
			target: { host: string; port: number };
			reach: Reach;
			reason: string;
	  };

/** `text` is the spelling the entry is stored and reported as, so the config
 * file's own capitalization and trailing dots cannot make two entries out of
 * one, or make a stored entry read differently from the one being matched. */
export type Entry =
	| { kind: "host"; host: string; port: number | null; text: string }
	| { kind: "ip"; host: string; port: number; text: string }
	| { kind: "local"; port: number; text: string };

function normalizeRequestHost(hostname: string): string | null {
	const host = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (host === "" || (!isHostname(host) && !isIpv4(host))) return null;
	return host;
}

/**
 * The one reading of an allow-list entry: `validateNetwork` in
 * session/projectconfig.ts drops whatever this rejects, so an entry can never
 * pass validation and then match something else here.
 *
 * A malformed entry is dropped rather than matched, so a policy assembled from
 * bad input denies instead of surprising.
 */
export function parseEntry(raw: string): Entry | null {
	const entry = raw.trim().toLowerCase().replace(/\.$/, "");
	const colon = entry.lastIndexOf(":");
	const hostPart = colon === -1 ? entry : entry.slice(0, colon);
	const portPart = colon === -1 ? null : entry.slice(colon + 1);

	let port: number | null = null;
	if (portPart !== null) {
		if (!/^\d{1,5}$/.test(portPart)) return null;
		port = Number(portPart);
		if (!isPort(port)) return null;
	}

	if (hostPart === "localhost") {
		return port === null
			? null
			: { kind: "local", port, text: `localhost:${port}` };
	}
	if (isIpv4(hostPart)) {
		// A port is required, so one entry cannot open every service at an
		// address, and the address has to be somewhere other than this machine: a
		// database on the LAN is an entry an operator may legitimately approve,
		// loopback is never one.
		const reachable = isPublicIpv4(hostPart) || isLanIpv4(hostPart);
		if (port === null || !reachable) return null;
		return { kind: "ip", host: hostPart, port, text: `${hostPart}:${port}` };
	}
	if (isHostname(hostPart)) {
		const text = port === null ? hostPart : `${hostPart}:${port}`;
		return { kind: "host", host: hostPart, port, text };
	}
	return null;
}

/**
 * The name a secret is injected for: a plain hostname, never an address or a
 * port, and never one of the fence's own names, which stand for this machine.
 */
export function parseSecretHost(raw: string): string | null {
	const entry = parseEntry(raw);
	if (entry?.kind !== "host" || entry.port !== null) return null;
	return entry.host.endsWith(FENCE_DOMAIN) ? null : entry.host;
}

export function isEnvName(name: string): boolean {
	return /^[A-Z_][A-Z0-9_]*$/.test(name);
}

/**
 * What the guest holds in place of a secret: fixed per variable name, with
 * nothing random in it. A placeholder is not a secret, so it needs no rotation
 * and no storage, and a fixed one keeps working when it outlives the helper
 * that was started with it: a guest process already running, a token saved to
 * `.npmrc`, a reattach after the helper died.
 */
export function placeholderFor(env: string): string {
	return `playpen-secret-${env.toLowerCase().replaceAll("_", "-")}`;
}

function matchesHost(entry: Extract<Entry, { kind: "host" }>, host: string) {
	return host === entry.host || host.endsWith(`.${entry.host}`);
}

function decideTarget(
	policy: Policy,
	hostname: string,
	port: number,
	own: ReadonlySet<string>,
): {
	allowed: boolean;
	target: { host: string; port: number };
	/**
	 * Unused where `target.host` is already an address (the alias mapping, an
	 * IP-literal entry): those dial it directly and never resolve a name.
	 */
	reach: Reach;
	reason: string;
	/** Refused in every mode: log mode opens the internet, never this machine. */
	final?: true;
	probe?: true;
} {
	const entries = policy.allow
		.map(parseEntry)
		.filter((e): e is Entry => e !== null);

	const host = normalizeRequestHost(hostname);
	if (host === null || !isPort(port)) {
		return {
			allowed: false,
			final: true,
			target: { host: hostname, port },
			reach: "public",
			reason: `cannot parse host "${hostname}" or port ${port}`,
		};
	}

	if (host === PROBE_HOST) {
		return {
			allowed: false,
			probe: true,
			target: { host, port },
			reach: "public",
			reason: `${PROBE_HOST} is the fence's own liveness check; nothing is dialed`,
		};
	}

	if (host === DENY_HOST) {
		return {
			allowed: false,
			final: true,
			target: { host, port },
			reach: "public",
			reason: `${DENY_HOST} is the fence's own refusal check; nothing is dialed`,
		};
	}

	if (host === HOST_ALIAS) {
		const local = entries.find((e) => e.kind === "local" && e.port === port);
		return local
			? {
					allowed: true,
					target: { host: "127.0.0.1", port },
					reach: "public",
					reason: `${HOST_ALIAS}:${port} maps to 127.0.0.1 via a localhost:${port} entry`,
				}
			: {
					allowed: false,
					final: true,
					target: { host: "127.0.0.1", port },
					reach: "public",
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
			reach: "public",
			reason: `${host} is refused; use ${HOST_ALIAS} to reach the host's loopback`,
		};
	}

	if (isIpv4(host)) {
		if (own.has(host)) {
			return {
				allowed: false,
				final: true,
				target: { host, port },
				reach: "public",
				reason: `${host} is an address of this machine; only a localhost:PORT entry reaches it`,
			};
		}
		const matched = entries.find(
			(e) => e.kind === "ip" && e.host === host && e.port === port,
		);
		if (matched) {
			return {
				allowed: true,
				target: { host, port },
				reach: "public",
				reason: `ip literal ${host}:${port} is explicitly allowed`,
			};
		}
		if (!isPublicIpv4(host)) {
			return {
				allowed: false,
				final: true,
				target: { host, port },
				reach: "public",
				reason: `${host} is not a public address and is not an allowed entry`,
			};
		}
		return {
			allowed: false,
			target: { host, port },
			reach: "public",
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
				// A port on the entry is what opens the LAN, mirroring an address
				// entry that names a LAN address directly with a port.
				reach: matched.port === null ? "public" : "lan",
				reason: `matches allow entry "${matched.text}"`,
			}
		: {
				allowed: false,
				target: { host, port },
				reach: "public",
				reason: `${host} is not in the allow list`,
			};
}

/**
 * `own` is every address this machine has on an interface. None of them is
 * ever dialed by address or reached by a name resolving there: a service on
 * this machine is opened by `localhost:PORT` alone, so a project cannot reach
 * it by its LAN or public address instead, and log mode cannot either.
 */
export function decide(
	policy: Policy,
	hostname: string,
	port: number,
	own: ReadonlySet<string> = new Set(),
): Verdict {
	const { allowed, target, reach, reason, final, probe } = decideTarget(
		policy,
		hostname,
		port,
		own,
	);
	if (probe) return { kind: "probe", reason };
	if (allowed) return { kind: "allow", target, reach, reason };
	if (policy.mode === "log" && !final)
		return { kind: "report", target, reach, reason };
	return { kind: "deny", reason };
}
