import { defineCommand } from "citty";
import { destroy, identify } from "../session/lifecycle.ts";

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

		await destroy(sb);
		console.log(`deleted ${sb.sandbox}`);
	},
});
