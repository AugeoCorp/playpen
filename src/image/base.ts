import { ubuntu } from "./distro.ts";
import {
	buildTools,
	claudeCode,
	mise,
	noatime,
	node,
	python,
} from "./layers.ts";
import { defineImage } from "./types.ts";

/** Scripts run in the order listed, so claudeCode() must follow node(), which supplies npm. */
export const baseImage = defineImage({
	name: "playpen-base",
	distro: ubuntu(),
	layers: [buildTools(), node(), mise(), python(), noatime(), claudeCode()],
});
