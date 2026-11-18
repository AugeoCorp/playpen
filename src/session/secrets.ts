import { validateHeaderValue } from "node:http";
import type { HeldSecret } from "../network/fence.ts";
import type { SecretGrant } from "../network/policy.ts";

/**
 * Takes each granted variable's value out of `env`, so no child spawned
 * afterwards inherits it. An unset or empty variable is returned in `missing`,
 * since a start that finds a helper already running does not need it.
 */
export function takeSecretValues(
	grants: readonly SecretGrant[],
	env: NodeJS.ProcessEnv,
): { held: HeldSecret[]; missing: string[] } {
	const names = [...new Set(grants.map((grant) => grant.env))];
	const held = names.flatMap((name) => {
		const value = env[name];
		delete env[name];
		if (value === undefined || value === "") return [];
		assertFitsHeader(name, value);
		return [{ env: name, value }];
	});
	const found = new Set(held.map((secret) => secret.env));
	return { held, missing: names.filter((name) => !found.has(name)) };
}

export function missingMessage(missing: readonly string[]): string {
	return `network.secrets needs ${missing.join(", ")} set in your environment`;
}

function assertFitsHeader(name: string, value: string): void {
	try {
		validateHeaderValue("authorization", value);
	} catch {
		throw new Error(
			`network.secrets: ${name} holds a character that cannot go in a request header`,
		);
	}
}
