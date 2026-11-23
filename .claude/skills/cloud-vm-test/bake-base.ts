// Writes playpen's base template with one extra first step that makes the
// guest trust the container's interception certificates, and prints the base's
// name and the template's path. Run it with `as_runner`.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { defaults, templatesDir } from "../../../src/config.ts";
import { currentHash } from "../../../src/image/bake.ts";
import { baseImage } from "../../../src/image/base.ts";
import { renderBase, serialize } from "../../../src/image/render.ts";
import { baseInstanceName } from "../../../src/session/identity.ts";

const bundle = "/opt/ca-bundle.crt";
const nodeRoots = new Set(rootCertificates.map(spaceless));
// Only the certificates that Node does not ship as roots: the guest already
// has those, and Lima cannot read a template line over 64 KiB, which the whole
// bundle in one script would be.
const interceptionCertificates = [
	...new Set(
		(await readFile(bundle, "utf8")).match(
			/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
		),
	),
].filter((pem) => !nodeRoots.has(spaceless(pem)));
if (interceptionCertificates.length === 0)
	throw new Error(`no interception certificates in ${bundle}`);

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
		"cat > /usr/local/share/ca-certificates/container-interception.crt <<'PEM'",
		...interceptionCertificates,
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

function spaceless(pem: string): string {
	return pem.replace(/\s+/g, "");
}
