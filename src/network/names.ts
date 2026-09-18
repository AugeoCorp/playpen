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
