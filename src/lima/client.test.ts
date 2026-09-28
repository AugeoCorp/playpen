import assert from "node:assert/strict";
import { test } from "node:test";
import { sshThroughControl } from "./client.ts";

/**
 * The value below is read by three parsers on its way to a socket: Lima splits
 * `$SSH` into a command, ssh expands percent tokens and hands the ProxyCommand
 * to `/bin/sh`, and socat splits the address it ends up with. The expected
 * strings here are spelled out in full because the escaping is the behaviour --
 * anything that survives all three layers is what these pin down.
 */

test("a plain socket path needs no escaping at all", () => {
	assert.equal(
		sshThroughControl("/home/ana/.local/share/playpen/net/api-ab12/x.sock"),
		`ssh -o "ProxyCommand=socat - 'UNIX-CONNECT:/home/ana/.local/share/playpen/net/api-ab12/x.sock'"`,
	);
});

test("a path with a space and a single quote survives all three parsers", () => {
	assert.equal(
		sshThroughControl("/home/it's me/my box/control.sock"),
		`ssh -o "ProxyCommand=socat - 'UNIX-CONNECT:/home/it\\\\'\\\\''s me/my box/control.sock'"`,
	);
});

test("a percent in the path is doubled, so ssh does not expand it", () => {
	assert.equal(
		sshThroughControl("/home/50%/control.sock"),
		`ssh -o "ProxyCommand=socat - 'UNIX-CONNECT:/home/50%%/control.sock'"`,
	);
});

test("a comma or a colon is escaped, since socat splits addresses on both", () => {
	assert.equal(
		sshThroughControl("/data/a,b/c:d/control.sock"),
		`ssh -o "ProxyCommand=socat - 'UNIX-CONNECT:/data/a\\\\,b/c\\\\:d/control.sock'"`,
	);
});
