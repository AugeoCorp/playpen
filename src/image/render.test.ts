import assert from "node:assert/strict";
import { test } from "node:test";
import { baseImage } from "./base.ts";
import { type ImageOptions, maskScript, renderBase } from "./render.ts";

const opts: ImageOptions = {
	cpus: 2,
	memory: "2GiB",
	disk: "8GiB",
	mountType: "virtiofs",
};

test("the template keeps Lima from answering the guest's name lookups from inside the fence", () => {
	const { template } = renderBase(baseImage, opts);
	assert.deepEqual(template.hostResolver, { enabled: false });
});

test("the template keeps Lima from copying the host's proxy variables into the guest", () => {
	const { template } = renderBase(baseImage, opts);
	assert.equal(template.propagateProxyEnv, false);
});

const MOUNT = "/home/u/proj";

/** The lines of a script between its loop header and `done`. */
function loopBody(script: string): string[] {
	const lines = script.split("\n");
	const from = lines.findIndex((l) => l.startsWith("for rel in"));
	return lines.slice(from + 1, lines.indexOf("done"));
}

test("a directory mask is a directory on the VM disk bound over the target, as it always was", () => {
	const body = loopBody(maskScript(MOUNT, ["node_modules"])).join("\n");
	assert.ok(
		body.includes(
			[
				'  mkdir -p "$store"',
				'  chown "$owner" "$store"',
				'  mkdir -p "$target"',
				'  if ! mountpoint -q "$target"; then',
				'    mount --bind "$store" "$target"',
				"  fi",
			].join("\n"),
		),
		`the directory lines changed:\n${body}`,
	);
});

test("a mask whose target is a file gets a file on the VM disk bound over it", () => {
	const body = loopBody(maskScript(MOUNT, [".env"])).join("\n");
	assert.match(
		body,
		/^ {2}if \[ -f "\$target" \] && \[ ! -L "\$target" \]; then$/m,
	);
	assert.match(body, /^ {4}touch "\$store"$/m);
	assert.match(
		body,
		/^ {4}mountpoint -q "\$target" \|\| mount --bind "\$store" "\$target"$/m,
	);
});

test("the file branch is decided before anything is created on the share, and ends its entry", () => {
	const body = loopBody(maskScript(MOUNT, [".env"]));
	const file = body.findIndex((l) => l.includes('[ -f "$target" ]'));
	const created = body.indexOf('  mkdir -p "$target"');
	assert.ok(file >= 0 && file < created);
	assert.ok(body.indexOf("    continue") < created);
});

test("every entry is quoted into the loop", () => {
	assert.match(
		maskScript(MOUNT, ["node_modules", ".env", "it's"]),
		/^for rel in 'node_modules' '\.env' 'it'\\''s'; do$/m,
	);
});
