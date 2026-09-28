import { defineCommand } from "citty";
import * as lima from "../lima/client.ts";
import { attached, identify } from "../session/lifecycle.ts";

export default defineCommand({
	meta: {
		name: "shell",
		description:
			"Interactive shell in the sandbox, then stop it (implies start)",
	},
	args: {
		keep: {
			type: "boolean",
			description: "Leave the sandbox running afterward",
			default: false,
		},
	},
	async run({ args }) {
		const sb = await identify(process.cwd());
		// Stopped once the last session detaches, like `claude` and `run`: a
		// sibling session still holds its own lease, so leaving this shell never
		// stops a VM someone else is sitting in.
		process.exitCode = await attached(sb, !args.keep, () =>
			lima.shell(sb.instance, sb.cwd, []),
		);
	},
});
