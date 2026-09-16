import type { PlaypenConfig } from "./src/session/projectconfig.ts";

// playpen imports this file on the host, so it and everything it imports runs
// as you. That is gated by an approval prompt keyed to the import graph; see
// src/session/trust.ts. The type import above is erased before Node loads
// anything, which keeps this a one-file graph.
export default {
	masked: ["node_modules"],
	setup: ["npm ci"],
} satisfies PlaypenConfig;
