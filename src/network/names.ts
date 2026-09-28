/**
 * The shapes an allow-list entry (`projectconfig.ts`) and a CONNECT target
 * (`policy.ts`) are both held to, so the config validator and the gatekeeper
 * cannot drift apart on what counts as a hostname, an IPv4 literal, or a port.
 */
export function isHostname(host: string): boolean {
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

export function isIpv4(host: string): boolean {
	const octets = host.split(".");
	return (
		octets.length === 4 &&
		octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
	);
}

export function isPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Never dialed, no matter what named it or what port an entry carries: a
 * cloud metadata service hands out credentials on link-local (169.254/16),
 * and 0.0.0.0/8 is a spelling Linux itself reads as loopback rather than a
 * real destination. Multicast (224/4) and the reserved 240/4 block, including
 * 255.255.255.255, are never a real single host either.
 */
function isNeverDialedIpv4(host: string): boolean {
	const [a = 0, b = 0] = host.split(".").map(Number);
	if (a === 0 || a >= 224) return true;
	return a === 169 && b === 254;
}

/**
 * A port-less allow entry's reach, and the address a bare IPv4 literal in a
 * request must be: everything outside this machine and the networks it is
 * on.
 */
export function isPublicIpv4(host: string): boolean {
	if (!isIpv4(host)) return false;
	const [a = 0] = host.split(".").map(Number);
	if (a === 127) return false;
	if (isNeverDialedIpv4(host)) return false;
	return !isLanIpv4(host);
}

/**
 * A ported allow entry's reach: public, this machine's own loopback
 * (127/8), or a LAN/CGNAT address -- the same addresses an entry naming one
 * of them directly, with a port, may already dial.
 */
export function isReachableIpv4(host: string): boolean {
	if (!isIpv4(host)) return false;
	return !isNeverDialedIpv4(host);
}

/**
 * The private ranges an operator may point an allow entry at -- RFC1918 plus
 * CGNAT. Not reachable from the internet, but not this machine either: a
 * database on the LAN lives here. Also part of what a ported name entry may
 * resolve to; see `isReachableIpv4`.
 */
export function isLanIpv4(host: string): boolean {
	if (!isIpv4(host)) return false;
	const [a = 0, b = 0] = host.split(".").map(Number);
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return a === 100 && b >= 64 && b <= 127;
}
