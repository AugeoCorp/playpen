import assert from "node:assert/strict";
import { test } from "node:test";
import { caTrust } from "./layers.ts";

const PEM =
	"-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUAAAA\n-----END CERTIFICATE-----\n";

test("the CA layer installs the certificate into the system store", () => {
	const script = caTrust(PEM).script ?? "";
	assert.ok(script.includes(PEM.trimEnd()));
	assert.match(
		script,
		/cat > \/usr\/local\/share\/ca-certificates\/playpen\.crt <<'PLAYPEN_CA_END'/,
	);
	assert.match(script, /^update-ca-certificates$/m);
});

test("the CA layer points Node, Python and uv at a bundle that holds the CA, for every session", () => {
	assert.deepEqual(caTrust(PEM).env, {
		NODE_EXTRA_CA_CERTS: "/usr/local/share/ca-certificates/playpen.crt",
		SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
		REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
	});
});

test("a base64 line in the certificate can never be the heredoc's delimiter", () => {
	const script =
		caTrust(
			"-----BEGIN CERTIFICATE-----\nMIIB\nPEM\nEOF\nSH\n-----END CERTIFICATE-----\n",
		).script ?? "";
	const delimiter = /<<'([^']+)'/.exec(script)?.[1] ?? "";
	assert.match(
		delimiter,
		/[^A-Za-z0-9+/=]/,
		`delimiter ${delimiter} is a base64 line`,
	);
	assert.equal(
		script.split("\n").filter((line) => line === delimiter).length,
		1,
	);
});

test("the CA layer refuses text that is not one PEM certificate", () => {
	assert.throws(
		() => caTrust(`${PEM}\nPLAYPEN_CA_END\ntouch /pwned\n`),
		/one PEM certificate/,
	);
	assert.throws(() => caTrust(`${PEM}${PEM}`), /one PEM certificate/);
});
