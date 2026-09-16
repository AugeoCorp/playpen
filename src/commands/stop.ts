import { defineCommand } from "citty";
import * as leases from "../session/leases.ts";
import { identify, stop } from "../session/lifecycle.ts";
import { withLock } from "../session/lock.ts";

export default defineCommand({
	meta: { name: "stop", description: "Stop the sandbox for this directory" },
	args: {
		force: {
			type: "boolean",
			description: "Stop even while other sessions are attached",
			default: false,
		},
	},
	async run({ args }) {
		const sb = await identify(process.cwd());

		// Counting and stopping under one lock: unlocked, a session could attach
		// between the two and be stopped anyway, which is the race the lock exists
		// to close.
		const stopped = await withLock(sb.sandbox, async () => {
			const others = await leases.live(sb.sandbox);

			if (others.length > 0 && !args.force) {
				const pids = others.map((o) => o.pid).join(", ");
				console.error(
					`${others.length} session${others.length === 1 ? " is" : "s are"} attached to ${sb.sandbox} (pid ${pids}).`,
				);
				console.error(`Stopping now cuts them off. Re-run with --force.`);
				return false;
			}

			// Their leases describe a VM that is about to be gone, so they are stale
			// the moment this returns; left behind they would block the next stop.
			if (others.length > 0) await leases.clear(sb.sandbox);

			await stop(sb);
			return true;
		});

		if (!stopped) {
			process.exitCode = 1;
			return;
		}
		console.log(`stopped ${sb.sandbox}`);
	},
});
