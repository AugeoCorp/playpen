import { defineCommand } from "citty";
import { ensureRunning, identify } from "../session/lifecycle.ts";

export default defineCommand({
  meta: {
    name: "up",
    description: "Create or start the sandbox for this directory, and leave it running",
  },
  async run() {
    const sb = await identify(process.cwd());
    console.log(`sandbox ${sb.sandbox} (${sb.instance})`);

    const { created } = await ensureRunning(sb);
    console.log(
      created
        ? `created and running; ${sb.cwd} is mounted read-write`
        : `running; ${sb.cwd} is mounted read-write`,
    );
    console.log(`next: playpen shell   or   playpen claude`);
  },
});
