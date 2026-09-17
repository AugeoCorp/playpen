import { defineCommand } from "citty";
import * as lima from "../lima/client.ts";
import { attached, identify } from "../session/lifecycle.ts";

export default defineCommand({
	meta: {
		name: "shell",
		description: "Interactive shell in the sandbox (implies start)",
	},
	async run() {
		const sb = await identify(process.cwd());
		// Leaves the sandbox running, but still holds a lease: a sibling `claude`
		// exiting must not stop the VM this shell is sitting in.
		process.exitCode = await attached(sb, false, () =>
			lima.shell(sb.instance, sb.cwd, []),
		);
	},
});
