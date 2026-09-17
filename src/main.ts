import { createRequire } from "node:module";
import { defineCommand } from "citty";

const { version } = createRequire(import.meta.url)("../package.json") as {
	version: string;
};

// Subcommands load lazily so cheap commands never pay for the image module graph.
export const main = defineCommand({
	meta: {
		name: "playpen",
		version,
		description: "Manage Lima VMs as disposable agent sandboxes",
	},
	subCommands: {
		start: () => import("./commands/start.ts").then((m) => m.default),
		shell: () => import("./commands/shell.ts").then((m) => m.default),
		run: () => import("./commands/run.ts").then((m) => m.default),
		claude: () => import("./commands/claude.ts").then((m) => m.default),
		setup: () => import("./commands/setup.ts").then((m) => m.default),
		list: () => import("./commands/list.ts").then((m) => m.default),
		stop: () => import("./commands/stop.ts").then((m) => m.default),
		remove: () => import("./commands/remove.ts").then((m) => m.default),
		image: () => import("./commands/image.ts").then((m) => m.default),
		doctor: () => import("./commands/doctor.ts").then((m) => m.default),
		completion: () => import("./commands/completion.ts").then((m) => m.default),
	},
});

/**
 * The short spellings, kept so a habit or a script does not break. Resolved
 * before citty parses, so only the full names reach help and completion; each
 * command's description carries its alias.
 */
export const ALIASES: Record<string, string> = {
	up: "start",
	ls: "list",
	rm: "remove",
};
