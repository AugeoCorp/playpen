import { defineCommand } from "citty";
import { bashScript, zshScript } from "../completion.ts";

const SHELLS = ["bash", "zsh"];

export default defineCommand({
	meta: {
		name: "completion",
		description: "Print a tab-completion script for bash or zsh",
	},
	args: {
		shell: {
			type: "positional",
			description: `Shell to generate for: ${SHELLS.join(" or ")}`,
			valueHint: SHELLS.join("|"),
		},
	},
	run({ args }) {
		const shell = String(args.shell);
		if (!SHELLS.includes(shell)) {
			console.error(`unknown shell ${JSON.stringify(shell)}`);
			console.error(`usage: playpen completion ${SHELLS.join("|")}`);
			process.exitCode = 1;
			return;
		}

		const render = shell === "bash" ? bashScript : zshScript;
		console.log(render("playpen").trimEnd());
	},
});
