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
 * The addresses a name is allowed to resolve to, and the ones a bare literal
 * request may name: everything outside this machine, the networks it is on,
 * and the ranges the kernel treats specially (0/8, which Linux reads as
 * loopback, 127/8, 169.254/16, the RFC1918 and CGNAT ranges, multicast and
 * the reserved 240/4 with 255.255.255.255 in it).
 */
export function isGlobalIpv4(host: string): boolean {
	if (!isIpv4(host)) return false;
	const [a = 0, b = 0] = host.split(".").map(Number);
	if (a === 0 || a === 127 || a >= 224) return false;
	if (a === 169 && b === 254) return false;
	return !isLanIpv4(host);
}

/**
 * The private ranges an operator may point an allow entry at -- RFC1918 plus
 * CGNAT. Not reachable from the internet, but not this machine either: a
 * database on the LAN lives here.
 */
export function isLanIpv4(host: string): boolean {
	if (!isIpv4(host)) return false;
	const [a = 0, b = 0] = host.split(".").map(Number);
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return a === 100 && b >= 64 && b <= 127;
}
