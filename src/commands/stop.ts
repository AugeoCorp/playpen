import { defineCommand } from "citty";
import { identify, stop } from "../session/lifecycle.ts";

export default defineCommand({
  meta: { name: "stop", description: "Stop the sandbox for this directory" },
  async run() {
    const sb = await identify(process.cwd());
    await stop(sb);
    console.log(`stopped ${sb.sandbox}`);
  },
});
