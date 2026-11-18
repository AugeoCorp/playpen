import type { HeldSecret } from "./fence.ts";
import { PLACEHOLDER, placeholderFor } from "./policy.ts";

export type Header = [name: string, value: string];

/**
 * Replaces each secret's placeholder with its value in the `Authorization`
 * headers, verbatim or inside `Basic` credentials, and lists the names that
 * went in. `Authorization` is where gh, git, curl `-u` and npm send a token;
 * every other header goes out as sent, since a host that echoes one back
 * (api.github.com quotes `X-GitHub-Api-Version` in an error) would hand the
 * value to the guest.
 *
 * `secrets` is only what may be sent to this request's host: a placeholder for
 * any other name is left as it is.
 */
export function rewriteHeaders(
	headers: readonly Header[],
	secrets: readonly HeldSecret[],
): { headers: Header[]; injected: string[] } {
	const values = new Map(
		secrets.map((secret) => [placeholderFor(secret.env), secret]),
	);
	const injected = new Set<string>();
	function swap(text: string): string {
		return text.replace(PLACEHOLDER, (placeholder) => {
			const secret = values.get(placeholder);
			if (secret === undefined) return placeholder;
			injected.add(secret.env);
			return secret.value;
		});
	}
	return {
		headers: headers.map(([name, value]) =>
			name.toLowerCase() === "authorization"
				? [name, swapInBasic(value, swap) ?? swap(value)]
				: [name, value],
		),
		injected: [...injected],
	};
}

/** The scheme is case-insensitive (RFC 9110, 11.1). */
const BASIC = /^(basic +)(\S+)$/i;

/**
 * git sends `Basic base64(user:token)`, so there the placeholder is only
 * visible decoded. Decoded as latin1 so every byte of the credentials survives
 * the round trip.
 */
function swapInBasic(
	value: string,
	swap: (text: string) => string,
): string | undefined {
	const [, scheme, encoded] = BASIC.exec(value) ?? [];
	if (scheme === undefined || encoded === undefined) return undefined;
	const decoded = Buffer.from(encoded, "base64").toString("latin1");
	const swapped = swap(decoded);
	if (swapped === decoded) return undefined;
	return `${scheme}${Buffer.from(swapped, "latin1").toString("base64")}`;
}
