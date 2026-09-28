import { ubuntu } from "./distro.ts";
import {
	buildTools,
	claudeCode,
	mise,
	noatime,
	node,
	python,
	tun2proxy,
} from "./layers.ts";
import { defineImage } from "./types.ts";

/** Scripts run in the order listed, so claudeCode() must follow node(), which supplies npm. */
export const baseImage = defineImage({
	name: "playpen-base",
	distro: ubuntu(),
	layers: [
		buildTools(),
		tun2proxy(),
		node(),
		mise(),
		python(),
		noatime(),
		claudeCode(),
	],
});
