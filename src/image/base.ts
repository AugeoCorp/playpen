import { ensureCa } from "../network/ca.ts";
import { ubuntu } from "./distro.ts";
import {
	buildTools,
	caTrust,
	claudeCode,
	mise,
	noatime,
	node,
	python,
	tun2proxy,
} from "./layers.ts";
import { defineImage } from "./types.ts";

/**
 * Scripts run in the order listed, so claudeCode() must follow node(), which
 * supplies npm, and caTrust() must follow buildTools(), which supplies
 * update-ca-certificates.
 */
export function baseImage(caCertPem: string) {
	return defineImage({
		name: "playpen-base",
		distro: ubuntu(),
		layers: [
			buildTools(),
			caTrust(caCertPem),
			tun2proxy(),
			node(),
			mise(),
			python(),
			noatime(),
			claudeCode(),
		],
	});
}

/**
 * The image as this install bakes it. Every caller that hashes or renders the
 * image goes through here, so they agree on which CA is in it.
 */
export async function loadBaseImage() {
	return baseImage((await ensureCa()).certPem);
}
