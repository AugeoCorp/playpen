/**
 * Egress policy, and a server that answers one question over a unix socket:
 * may this host be reached?
 *
 * mitmproxy loads Python addons and nothing else, so the addon that asks is
 * Python. Keeping the answer here means the policy is written and tested in
 * the language the rest of playpen is, and the addon holds no opinion.
 */

import { rmSync } from "node:fs";
import { createServer } from "node:net";

export type Verdict = "allow" | "deny";

export interface Policy {
	/** Domain suffixes that may be reached. Empty allows everything. */
	allow: string[];
	/** When false, a denied host is recorded and let through anyway. */
	enforce: boolean;
}

export function verdict(policy: Policy, host: string): Verdict {
	if (policy.allow.length === 0) return "allow";
	const name = host.toLowerCase().replace(/\.$/, "");
	return policy.allow.some((a) => {
		const suffix = a.toLowerCase().replace(/^\.|\.$/g, "");
		return name === suffix || name.endsWith(`.${suffix}`);
	})
		? "allow"
		: "deny";
}

/** One line in, one line out: `<host>\n` then `allow|deny|report\n`. */
export function answer(policy: Policy, host: string): string {
	const v = verdict(policy, host);
	if (v === "allow") return "allow";
	return policy.enforce ? "deny" : "report";
}

export function serve(
	policy: Policy,
	socketPath: string,
	onVerdict?: (host: string, reply: string) => void,
): ReturnType<typeof createServer> {
	// A socket file outlives the process that bound it, so a stale one would
	// fail the bind while nobody is listening on it.
	rmSync(socketPath, { force: true });
	const server = createServer((conn) => {
		conn.setEncoding("utf8");
		let buffer = "";
		conn.on("data", (chunk: string) => {
			buffer += chunk;
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const host = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				const reply = answer(policy, host);
				onVerdict?.(host, reply);
				conn.write(`${reply}\n`);
				nl = buffer.indexOf("\n");
			}
		});
		conn.on("error", () => conn.destroy());
	});
	server.listen(socketPath);
	return server;
}

if (process.argv[1]?.endsWith("policy.ts")) {
	const socketPath = process.argv[2];
	if (!socketPath) {
		console.error("usage: policy.ts <socket> [allow,suffixes] [enforce]");
		process.exit(2);
	}
	const policy: Policy = {
		allow: (process.argv[3] ?? "").split(",").filter(Boolean),
		enforce: process.argv[4] === "enforce",
	};
	serve(policy, socketPath, (host, reply) =>
		console.log(`PLAYPEN ${reply} host=${JSON.stringify(host)}`),
	);
	console.log(
		`policy on ${socketPath}: allow=[${policy.allow.join(",")}] enforce=${policy.enforce}`,
	);
}
