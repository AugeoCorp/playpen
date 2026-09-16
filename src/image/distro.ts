import type { Distro } from "./types.ts";

/**
 * `template:_images/ubuntu` is Lima's own image list, so no cloud image URL or
 * digest is hardcoded here. `template:_default/mounts` is deliberately not
 * inherited: it would mount the host home read-only.
 */
export function ubuntu(): Distro {
	return {
		name: "ubuntu",
		baseTemplate: "template:_images/ubuntu",
		installCmd(packages) {
			return [
				"export DEBIAN_FRONTEND=noninteractive",
				"apt-get update -qq",
				`apt-get install -y --no-install-recommends ${packages.join(" ")}`,
			].join("\n");
		},
	};
}

export function fedora(): Distro {
	return {
		name: "fedora",
		baseTemplate: "template:_images/fedora",
		installCmd(packages) {
			return `dnf install -y ${packages.join(" ")}`;
		},
	};
}
