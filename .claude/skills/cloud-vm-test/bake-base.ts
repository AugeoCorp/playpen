// Writes playpen's base template with one extra first step that makes the
// guest trust the container's egress proxy, and prints the base's name. Run
// as runner with the same XDG_DATA_HOME as `pp`; see SKILL.md.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { defaults, templatesDir } from "../../../src/config.ts";
import { currentHash } from "../../../src/image/bake.ts";
import { baseImage } from "../../../src/image/base.ts";
import { renderBase, serialize } from "../../../src/image/render.ts";
import { baseInstanceName } from "../../../src/session/identity.ts";

// Only the certificates that are not public roots: the guest already has
// those, and Lima cannot read a template line over 64 KiB, which the whole
// bundle in one script would be.
const bundle = await readFile(process.argv[2] ?? "/opt/ca-bundle.crt", "utf8");
const spaceless = (pem: string) => pem.replace(/\s+/g, "");
const publicRoots = new Set(rootCertificates.map(spaceless));
const ca = [
	...new Set(
		(
			bundle.match(
				/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
			) ?? []
		).filter((pem) => !publicRoots.has(spaceless(pem))),
	),
].join("\n");
const rendered = renderBase(baseImage, defaults);
const template = rendered.template as {
	provision: unknown[];
	env?: Record<string, string>;
};
// npm keeps its own CA list, so the system store alone does not cover the
// Claude Code install. Lima exports `env` to provisioning and to
// /etc/environment.
template.env = {
	...template.env,
	NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
};
template.provision.unshift({
	mode: "system",
	script: [
		"#!/bin/bash",
		"set -euo pipefail",
		"cat > /usr/local/share/ca-certificates/container-egress-proxy.crt <<'PEM'",
		ca,
		"PEM",
		"update-ca-certificates",
	].join("\n"),
});

const name = baseInstanceName(
	currentHash(),
	new Date().toISOString().slice(0, 10),
);
await mkdir(templatesDir(), { recursive: true });
const path = join(templatesDir(), `${name}.yaml`);
await writeFile(path, `${serialize(rendered)}\n`, "utf8");
console.log(`${name} ${path}`);
