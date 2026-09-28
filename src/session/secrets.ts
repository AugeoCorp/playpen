import { randomBytes } from "node:crypto";
import type { HeldSecret } from "../network/fence.ts";
import type { SecretGrant } from "../network/policy.ts";

/** Where the guest's login shells find the placeholders. */
export const PROFILE_PATH = "/etc/profile.d/playpen-secrets.sh";

/** A fresh one on every call, so a placeholder cannot outlive the start that made it. */
export function placeholderFor(env: string): string {
	const name = env.toLowerCase().replaceAll("_", "-");
	return `playpen-secret-${name}-${randomBytes(8).toString("hex")}`;
}

function listNames(names: readonly string[]): string {
	if (names.length < 2) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Reads each granted variable from `env`. An unset or empty one refuses the
 * start, and every such name is listed at once so the user fixes them in one
 * go. The message carries names only.
 */
export function readSecretValues(
	grants: readonly SecretGrant[],
	env: NodeJS.ProcessEnv,
): HeldSecret[] {
	const held: HeldSecret[] = [];
	const missing: string[] = [];
	for (const grant of grants) {
		const value = env[grant.env];
		if (value === undefined || value === "") {
			missing.push(grant.env);
			continue;
		}
		held.push({
			env: grant.env,
			placeholder: placeholderFor(grant.env),
			value,
			hosts: [...grant.hosts],
		});
	}
	if (missing.length > 0) {
		throw new Error(
			`network.secrets needs ${listNames(missing)} set in your environment`,
		);
	}
	return held;
}

function quote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The guest script and its stdin that leave `PROFILE_PATH` holding exactly
 * `placeholders`, or absent when there are none, so a secret dropped from the
 * config disappears from the guest. The content goes over stdin and the script
 * is fixed, so nothing here becomes shell syntax. Renamed into place, and
 * from a name profile.d does not source, so a login shell never reads it half
 * written.
 */
export function profileCommand(
	placeholders: readonly { env: string; placeholder: string }[],
): { script: string; input?: string } {
	if (placeholders.length === 0) return { script: `rm -f ${PROFILE_PATH}` };
	return {
		script: [
			"set -euo pipefail",
			"umask 022",
			`cat > ${PROFILE_PATH}.tmp`,
			`mv ${PROFILE_PATH}.tmp ${PROFILE_PATH}`,
		].join("\n"),
		input: `${placeholders
			.map(({ env, placeholder }) => `export ${env}=${quote(placeholder)}`)
			.join("\n")}\n`,
	};
}
