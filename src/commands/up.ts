import { defineCommand } from "citty";
import { attached, identify } from "../session/lifecycle.ts";

export default defineCommand({
	meta: {
		name: "up",
		description:
			"Create or start the sandbox for this directory, and leave it running",
	},
	async run() {
		const sb = await identify(process.cwd());
		console.log(`sandbox ${sb.sandbox} (${sb.instance})`);

		// Leaves it running, so it takes no lease of its own -- but goes through
		// the same lock, which keeps two concurrent creations from racing.
		const { created, setupOk } = await attached(sb, false, async (r) => r);
		console.log(
			created
				? `created and running; ${sb.cwd} is mounted read-write`
				: `running; ${sb.cwd} is mounted read-write`,
		);
		// The sandbox is up either way, so this is the exit code rather than a
		// throw -- but `up` is the command that reports whether it is ready.
		if (!setupOk) process.exitCode = 1;
		console.log(`next: playpen shell   or   playpen claude`);
	},
});
