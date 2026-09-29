import type { z } from "zod";

/**
 * The first problem found, as a plain sentence that names the key the way the
 * file spells it: "playpen.config.js: `network.ports[1]` must be …". A problem
 * with the value as a whole has no key, so the subject is its own:
 * "playpen.config.js has no default export".
 */
export function describeIssue(error: z.ZodError, subject?: string): string {
	const { path, message } = error.issues[0] ?? {
		path: [],
		message: "is not valid",
	};
	const key = path
		.map((k, i) =>
			typeof k === "number" ? `[${k}]` : `${i === 0 ? "" : "."}${String(k)}`,
		)
		.join("");
	const sentence = key === "" ? message : `\`${key}\` ${message}`;
	if (subject === undefined) return sentence;
	return key === "" ? `${subject} ${sentence}` : `${subject}: ${sentence}`;
}
