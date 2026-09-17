import { defineCommand } from "citty";
import * as lima from "../lima/client.ts";
import { type FenceState, fenceStatus } from "../network/fence.ts";
import {
	instanceName,
	isBaseInstance,
	isPlaypenInstance,
	sandboxFromInstance,
} from "../session/identity.ts";
import * as leases from "../session/leases.ts";
import * as store from "../session/store.ts";

/** `fenceStatus`'s states, plus the `?` shown when it could not be read. */
export function netLabel(state: FenceState | null): string {
	switch (state) {
		case "sealed":
			return "sealed";
		case "sealed-no-gatekeeper":
			return "no gate";
		case "unsealed":
			return "OPEN";
		case "stopped":
			return "-";
		case null:
			return "?";
	}
}

function age(iso: string | undefined): string {
	if (!iso) return "-";
	const ms = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export default defineCommand({
	meta: { name: "list", description: "List playpen sandboxes (alias: ls)" },
	async run() {
		const instances = (await lima.list()).filter(
			(i) => isPlaypenInstance(i.name) && !isBaseInstance(i.name),
		);
		const metas = new Map((await store.all()).map((m) => [m.name, m]));

		if (instances.length === 0) {
			console.log("no sandboxes");
			return;
		}

		const rows = await Promise.all(
			instances.map(async (i) => {
				const sandbox = sandboxFromInstance(i.name);
				const meta = metas.get(sandbox);
				const attached = (await leases.live(sandbox)).length;
				const net = await fenceStatus(sandbox, instanceName(sandbox)).catch(
					() => null,
				);
				return {
					name: sandbox,
					status: i.status,
					used: age(meta?.lastUsed),
					att: attached === 0 ? "-" : String(attached),
					net: netLabel(net),
					pin: meta?.pinned ? "*" : " ",
					cwd: meta?.cwd ?? "(unknown)",
				};
			}),
		);

		const w = (key: keyof (typeof rows)[number]) =>
			Math.max(key.length, ...rows.map((r) => String(r[key]).length));
		const wName = w("name");
		const wStatus = w("status");
		const wUsed = Math.max(4, w("used"));
		const wAtt = Math.max(3, w("att"));
		const wNet = Math.max(3, w("net"));

		console.log(
			`  ${"NAME".padEnd(wName)}  ${"STATUS".padEnd(wStatus)}  ${"USED".padEnd(wUsed)}  ${"ATT".padEnd(wAtt)}  ${"NET".padEnd(wNet)}  DIR`,
		);
		for (const r of rows) {
			console.log(
				`${r.pin} ${r.name.padEnd(wName)}  ${r.status.padEnd(wStatus)}  ${r.used.padEnd(wUsed)}  ${r.att.padEnd(wAtt)}  ${r.net.padEnd(wNet)}  ${r.cwd}`,
			);
		}
	},
});
