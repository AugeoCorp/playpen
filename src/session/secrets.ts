import type { HeldSecret } from "../network/fence.ts";
import type { SecretGrant } from "../network/policy.ts";

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
