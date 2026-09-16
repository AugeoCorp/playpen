import { defineCommand } from "citty";
import * as leases from "../session/leases.ts";
import { destroy, identify } from "../session/lifecycle.ts";
import { withLock } from "../session/lock.ts";

export default defineCommand({
	meta: {
		name: "rm",
		description:
			"Delete the sandbox VM for this directory (your files are untouched)",
	},
	args: {
		yes: {
			type: "boolean",
			description: "Skip confirmation",
			default: false,
			alias: ["y"],
		},
		force: {
			type: "boolean",
			description: "Delete even while other sessions are attached",
			default: false,
		},
	},
	async run({ args }) {
		const sb = await identify(process.cwd());

		if (!args.yes) {
			console.error(`This deletes VM ${sb.instance}.`);
			console.error(`${sb.cwd} is a host mount and is not affected.`);
			console.error(`Installed packages and other guest-local state are lost.`);
			console.error(
				`Claude transcripts and memory are saved, and restored by the next up.`,
			);
			console.error(`Re-run with --yes to proceed.`);
			process.exitCode = 1;
			return;
		}

		// Checked and destroyed under one lock: unlocked, a session attaching in
		// between would have its guest disk deleted underneath it, which is what
		// the gate exists to prevent. Worse than stopping, so it is gated on a
		// live lease rather than on rm itself.
		const deleted = await withLock(sb.sandbox, async () => {
			const others = await leases.live(sb.sandbox);
			if (others.length > 0 && !args.force) {
				const pids = others.map((o) => o.pid).join(", ");
				console.error(
					`${others.length} session${others.length === 1 ? " is" : "s are"} attached to ${sb.sandbox} (pid ${pids}).`,
				);
				console.error(`Deleting now cuts them off. Re-run with --force.`);
				return false;
			}
			await leases.clear(sb.sandbox);
			await destroy(sb);
			return true;
		});

		if (!deleted) {
			process.exitCode = 1;
			return;
		}
		console.log(`deleted ${sb.sandbox}`);
	},
});
