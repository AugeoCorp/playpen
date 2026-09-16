import { defineCommand } from "citty";
import { ensureRunning, identify, runSetup } from "../session/lifecycle.ts";
import { CONFIG_FILE } from "../session/projectconfig.ts";

export default defineCommand({
	meta: {
		name: "setup",
		description: "Re-run this project's setup steps in the sandbox",
	},
	async run() {
		const sb = await identify(process.cwd());
		// Reuses the config this loaded, so the steps that run are the ones its
		// trust prompt showed.
		const { created, setupOk, setup } = await ensureRunning(sb);

		if (setup.length === 0) {
			console.error(`no \`setup\` in ${CONFIG_FILE}; nothing to run`);
			return;
		}
		// Creating one already ran them, and running them twice is only waste.
		if (created) {
			if (!setupOk) process.exitCode = 1;
			return;
		}
		if (!(await runSetup(sb, setup))) process.exitCode = 1;
	},
});
