import type { HeldSecret } from "./fence.ts";
import { placeholderFor } from "./policy.ts";

/** One header that had a placeholder replaced, and whose value went in. */
export interface Injection {
	header: string;
	env: string;
}

/**
 * The scheme is case-insensitive (RFC 9110, 11.1); the credentials must be
 * canonical base64, checked by re-encoding, since Node's decoder skips any
 * character it does not know rather than failing.
 */
const BASIC = /^(basic +)(\S+)$/i;

/**
 * The one header a value goes into, since it is where gh, git, curl `-u` and
 * npm send a token. A host that echoes some other request header back, as
 * api.github.com does `X-GitHub-Api-Version` in an error body, would otherwise
 * hand the value to the guest.
 */
const INJECTABLE = "authorization";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Longest first, so a placeholder that begins another (`GH` and `GH_TOKEN`)
 * never takes the front of the longer one; and in one pass, so a value is
 * never searched for a placeholder after it has gone in.
 */
function replacer(
	secrets: readonly HeldSecret[],
): (text: string, used: Set<string>) => string {
	const byPlaceholder = new Map(
		secrets.map((secret) => [placeholderFor(secret.env), secret]),
	);
	const pattern = new RegExp(
		[...byPlaceholder.keys()]
			.sort((a, b) => b.length - a.length)
			.map(escapeRegExp)
			.join("|"),
		"g",
	);
	return (text, used) =>
		text.replace(pattern, (placeholder) => {
			const secret = byPlaceholder.get(placeholder);
			if (secret === undefined) return placeholder;
			used.add(secret.env);
			return secret.value;
		});
}

/**
 * git sends `Basic base64(user:token)`, so there the placeholder is only
 * visible decoded. Bytes are carried as latin1 so the credentials survive the
 * round trip whatever they hold.
 */
function swapInBasic(
	value: string,
	swap: (text: string, used: Set<string>) => string,
	used: Set<string>,
): string {
	const match = BASIC.exec(value);
	if (match === null) return value;
	const [, scheme, encoded] = match as unknown as [string, string, string];
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.toString("base64") !== encoded) return value;
	const decoded = bytes.toString("latin1");
	const swapped = swap(decoded, used);
	if (swapped === decoded) return value;
	return `${scheme}${Buffer.from(swapped, "latin1").toString("base64")}`;
}

/**
 * Replaces each secret's placeholder with its value in the `Authorization`
 * headers of `rawHeaders` (the flat `[name, value, name, value, …]` list Node
 * reads a request into): inside decoded `Basic` credentials, or failing that
 * verbatim anywhere in the value, each tried on the header as sent. Every other
 * header, and every name, goes out as sent.
 *
 * `secrets` is only what may be sent to this request's host; a placeholder for
 * any other secret is left as it is. Each header a value went into is listed
 * once per secret, which is what gets logged.
 */
export function rewriteHeaders(
	rawHeaders: readonly string[],
	secrets: readonly HeldSecret[],
): { headers: string[]; injected: Injection[] } {
	if (secrets.length === 0) return { headers: [...rawHeaders], injected: [] };
	const swap = replacer(secrets);
	const headers: string[] = [];
	const injected: Injection[] = [];
	for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
		const header = rawHeaders[i] as string;
		const sent = rawHeaders[i + 1] as string;
		if (header.toLowerCase() !== INJECTABLE) {
			headers.push(header, sent);
			continue;
		}
		const used = new Set<string>();
		const basic = swapInBasic(sent, swap, used);
		headers.push(header, basic !== sent ? basic : swap(sent, used));
		for (const env of used) injected.push({ header, env });
	}
	return { headers, injected };
}
