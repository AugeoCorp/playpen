import { defineCommand } from "citty";
import { defaults } from "../config.ts";
import { buildBase, findBase } from "../image/bake.ts";
import { baseImage } from "../image/base.ts";
import { render, serialize } from "../image/render.ts";

export default defineCommand({
	meta: { name: "image", description: "Inspect the sandbox image definition" },
	subCommands: {
		build: defineCommand({
			meta: {
				name: "build",
				description: "Bake the base image that sandboxes clone from",
			},
			args: {
				force: {
					type: "boolean",
					description: "Bake a new dated base from the same definition",
					default: false,
				},
			},
			async run({ args }) {
				if (!args.force) {
					const existing = await findBase();
					if (existing) {
						console.log(`already built: ${existing}`);
						console.log(
							`bake a fresh one onto current packages: playpen image build --force`,
						);
						return;
					}
				}
				console.error(
					`baking the base image; this runs once and takes a few minutes`,
				);
				console.log(`built ${await buildBase()}`);
			},
		}),
		show: defineCommand({
			meta: {
				name: "show",
				description: "Print the rendered Lima template and hash",
			},
			args: {
				mount: {
					type: "string",
					description: "Directory to render as the mount (default: cwd)",
				},
			},
			run({ args }) {
				// citty types string args loosely, so narrow before use.
				const mount =
					typeof args.mount === "string" ? args.mount : process.cwd();
				const rendered = render(baseImage, {
					mount,
					cpus: defaults.cpus,
					memory: defaults.memory,
					disk: defaults.disk,
					mountType: defaults.mountType,
				});
				console.log(serialize(rendered));
				console.error(`\nimage hash: ${rendered.contentHash}`);
			},
		}),
	},
});
