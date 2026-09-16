import { defineCommand } from "citty";
import * as lima from "../lima/client.ts";
import { ensureRunning, identify } from "../session/lifecycle.ts";

export default defineCommand({
	meta: {
		name: "shell",
		description: "Interactive shell in the sandbox (implies up)",
	},
	async run() {
		const sb = await identify(process.cwd());
		await ensureRunning(sb);
		const code = await lima.shell(sb.instance, sb.cwd, []);
		process.exitCode = code;
	},
});
