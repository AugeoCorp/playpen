import { validateHeaderValue } from "node:http";
import type { HeldSecret } from "../network/fence.ts";
import {
	placeholderFor,
	type SecretGrant,
	secretNames,
} from "../network/policy.ts";

/** Run as root in the guest with `placeholderProfile` on stdin. */
export const PROFILE_SCRIPT = "cat > /etc/profile.d/playpen-secrets.sh";

/**
 * Takes each granted variable's value out of `env`, every one before any is
 * checked, so no child spawned afterwards inherits it, even after a refusal.
 * Every command needs every variable, even when a helper is already running
 * with the values.
 */
export function takeSecretValues(
	grants: readonly SecretGrant[],
	env: NodeJS.ProcessEnv,
): HeldSecret[] {
	const names = secretNames(grants);
	const held = names.map((name) => ({ env: name, value: env[name] ?? "" }));
	names.forEach((name) => {
		delete env[name];
	});
	const missing = held
		.filter((secret) => secret.value === "")
		.map((secret) => secret.env);
	if (missing.length > 0) {
		throw new Error(
			`network.secrets needs ${missing.join(", ")} set in your environment`,
		);
	}
	held.forEach((secret) => {
		assertFitsHeader(secret.env, secret.value);
	});
	return held;
}

/**
 * What the guest's login shells source: each name set to its placeholder. With
 * no names it is empty, so a secret dropped from the config leaves the guest.
 */
export function placeholderProfile(grants: readonly SecretGrant[]): string {
	return secretNames(grants)
		.map((name) => `export ${name}=${placeholderFor(name)}\n`)
		.join("");
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
