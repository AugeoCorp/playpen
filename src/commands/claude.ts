import { defineCommand } from "citty";
import * as lima from "../lima/client.ts";
import { pushClaudeConfig } from "../session/claudeconfig.ts";
import { ensureRunning, identify, stop } from "../session/lifecycle.ts";
import * as store from "../session/store.ts";

export default defineCommand({
  meta: {
    name: "claude",
    description: "Run Claude Code inside the sandbox, then stop it",
  },
  args: {
    keep: {
      type: "boolean",
      description: "Leave the sandbox running afterward",
      default: false,
    },
    auth: {
      type: "boolean",
      description: "Copy host credentials into the sandbox",
      default: true,
    },
    sync: {
      type: "boolean",
      description: "Copy CLAUDE.md, settings, skills and plugins into the sandbox",
      default: true,
    },
    "force-sync": {
      type: "boolean",
      description: "Re-copy even when nothing changed",
      default: false,
    },
  },
  async run({ args }) {
    const passthrough = args._ as string[];
    const sb = await identify(process.cwd());
    await ensureRunning(sb);

    if (args.sync || args.auth) {
      const meta = await store.load(sb.sandbox);
      const result = await pushClaudeConfig(sb.instance, {
        includeConfig: args.sync,
        includeCredentials: args.auth,
        projectDir: sb.cwd,
        ...(args["force-sync"] ? {} : { skipIfHash: meta?.configHash ?? "" }),
      });

      if (result.error) {
        console.error(`warning: config sync failed: ${result.error}`);
      } else if (result.skipped) {
        console.error("config unchanged, skipping sync");
      } else {
        const mb = (result.bytes / 1_000_000).toFixed(1);
        console.error(`synced ${result.pushed.join(", ")} (${mb} MB)`);
        if (meta) await store.save({ ...meta, configHash: result.hash });
      }
    }

    const code = await lima.shell(sb.instance, sb.cwd, ["claude", ...passthrough]);

    // Stopped by default, like `run`: nothing else reaps an 8GiB reservation.
    if (!args.keep) await stop(sb);

    process.exitCode = code;
  },
});
