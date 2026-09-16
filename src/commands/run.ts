import { defineCommand } from "citty";
import * as lima from "../lima/client.ts";
import { attached, identify } from "../session/lifecycle.ts";

export default defineCommand({
	meta: {
		name: "run",
		description: "Run a command in the sandbox, then stop it",
	},
	args: {
		keep: {
			type: "boolean",
			description: "Leave the sandbox running afterward",
			default: false,
		},
	},
	async run({ args }) {
		// citty puts everything after `--` in `_`.
		const command = args._ as string[];
		if (command.length === 0) {
			console.error("usage: playpen run [--keep] -- <command...>");
			process.exitCode = 2;
			return;
		}

		const sb = await identify(process.cwd());

		// Stopped even when the command failed: the VM's state should not depend
		// on it -- but not while another session is still attached.
		process.exitCode = await attached(sb, !args.keep, () =>
			lima.shell(sb.instance, sb.cwd, command),
		);
	},
});
