import { defineCommand } from "citty";
import { defaults } from "../config.ts";
import { baseImage } from "../image/base.ts";
import { render, serialize } from "../image/render.ts";

export default defineCommand({
  meta: { name: "image", description: "Inspect the sandbox image definition" },
  subCommands: {
    show: defineCommand({
      meta: { name: "show", description: "Print the rendered Lima template and hash" },
      args: {
        mount: {
          type: "string",
          description: "Directory to render as the mount (default: cwd)",
        },
      },
      run({ args }) {
        // citty types string args loosely, so narrow before use.
        const mount = typeof args.mount === "string" ? args.mount : process.cwd();
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
