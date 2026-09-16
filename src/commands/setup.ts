import { defineCommand } from "citty";
import { attached, identify, runSetup } from "../session/lifecycle.ts";
import { CONFIG_FILE } from "../session/projectconfig.ts";

export default defineCommand({
	meta: {
		name: "setup",
		description: "Re-run this project's setup steps in the sandbox",
	},
	async run() {
		const sb = await identify(process.cwd());
		// Holds a lease, so a sibling exiting cannot stop the VM mid-install.
		// Reuses the config `attached` loaded, so the steps that run are the ones
		// its trust prompt showed.
		await attached(sb, false, async ({ created, setupOk, setup }) => {
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
		});
	},
});
