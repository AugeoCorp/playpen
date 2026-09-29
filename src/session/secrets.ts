import type { HeldSecret } from "../network/fence.ts";
import type { SecretGrant } from "../network/policy.ts";

/** Where the guest's login shells find the placeholders. */
export const PROFILE_PATH = "/etc/profile.d/playpen-secrets.sh";

function listNames(names: readonly string[]): string {
	if (names.length < 2) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function missingMessage(missing: readonly string[]): string {
	return `network.secrets needs ${listNames(missing)} set in your environment`;
}

/**
 * Reads each granted variable from `env`, once per name however many grants
 * name it. An unset or empty one is returned in `missing`, so the caller can
 * list every such name at once.
 */
export function readSecretValues(
	grants: readonly SecretGrant[],
	env: NodeJS.ProcessEnv,
): { held: HeldSecret[]; missing: string[] } {
	const held: HeldSecret[] = [];
	const missing: string[] = [];
	for (const name of new Set(grants.map((grant) => grant.env))) {
		const value = env[name];
		if (value === undefined || value === "") missing.push(name);
		else held.push({ env: name, value });
	}
	return { held, missing };
}

function quote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The guest script and its stdin that leave `path` holding exactly
 * `placeholders`, or absent when there are none, so a secret dropped from the
 * config disappears from the guest. The content goes over stdin and the script
 * is fixed, so nothing here becomes shell syntax. Renamed into place, and
 * from a name profile.d does not source, so a login shell never reads it half
 * written.
 */
export function profileCommand(
	placeholders: readonly { env: string; placeholder: string }[],
	path: string = PROFILE_PATH,
): { script: string; input?: string } {
	if (placeholders.length === 0) return { script: `rm -f ${path}` };
	return {
		script: [
			"set -euo pipefail",
			"umask 022",
			`cat > ${path}.tmp`,
			`mv ${path}.tmp ${path}`,
		].join("\n"),
		input: `${placeholders
			.map(({ env, placeholder }) => `export ${env}=${quote(placeholder)}`)
			.join("\n")}\n`,
	};
}
