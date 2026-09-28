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
		/cat > \/usr\/local\/share\/ca-certificates\/playpen\.crt <<'PEM'/,
	);
	assert.match(script, /^update-ca-certificates$/m);
});

test("the CA layer points Node and Python at a bundle that holds the CA, for login shells", () => {
	const script = caTrust(PEM).script ?? "";
	assert.match(script, /> \/etc\/profile\.d\/playpen-ca\.sh /);
	assert.match(
		script,
		/^export NODE_EXTRA_CA_CERTS=\/usr\/local\/share\/ca-certificates\/playpen\.crt$/m,
	);
	assert.match(
		script,
		/^export SSL_CERT_FILE=\/etc\/ssl\/certs\/ca-certificates\.crt$/m,
	);
	assert.match(
		script,
		/^export REQUESTS_CA_BUNDLE=\/etc\/ssl\/certs\/ca-certificates\.crt$/m,
	);
});

test("the CA layer refuses text that could end its heredoc early", () => {
	assert.throws(
		() => caTrust(`${PEM}\nPEM\ntouch /pwned\n`),
		/one PEM certificate/,
	);
});
