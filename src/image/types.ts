/**
 * One installable unit of the sandbox image. `packages` from every layer
 * collapse into a single package-manager transaction; each `script` becomes
 * one Lima provision entry, in declaration order.
 */
export interface Layer {
	name: string;
	packages?: string[];
	script?: string;
	/** Lima provision mode; `system` runs as root. */
	mode?: "system" | "user";
	/** Exported into the guest. */
	env?: Record<string, string>;
}

export interface Distro {
	/** Lima `base` locator supplying the image list, e.g. `template:_images/ubuntu`. */
	baseTemplate: string;
	name: string;
	/** Shell to install the given packages non-interactively and idempotently. */
	installCmd(packages: readonly string[]): string;
}

export interface ImageDef {
	name: string;
	distro: Distro;
	layers: Layer[];
}

export function defineImage(def: ImageDef): ImageDef {
	return def;
}

export function defineLayer(layer: Layer): Layer {
	return layer;
}
