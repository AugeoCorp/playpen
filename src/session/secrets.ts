import { validateHeaderValue } from "node:http";
import type { HeldSecret } from "../network/fence.ts";
import { type SecretGrant, secretNames } from "../network/policy.ts";

/**
 * Takes each granted variable's value out of `env`, every one before any is
 * checked, so no child spawned afterwards inherits it, even after a refusal.
 * An unset or empty variable is returned in `missing`, since a start that
 * finds a helper already running does not need it.
 */
export function takeSecretValues(
	grants: readonly SecretGrant[],
	env: NodeJS.ProcessEnv,
): { held: HeldSecret[]; missing: string[] } {
	const names = secretNames(grants);
	const read = names.map((name) => ({ env: name, value: env[name] ?? "" }));
	names.forEach((name) => {
		delete env[name];
	});
	const held = read.filter((secret) => secret.value !== "");
	held.forEach((secret) => {
		assertFitsHeader(secret.env, secret.value);
	});
	return {
		held,
		missing: read
			.filter((secret) => secret.value === "")
			.map((secret) => secret.env),
	};
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
