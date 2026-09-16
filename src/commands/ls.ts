import { defineCommand } from "citty";
import * as lima from "../lima/client.ts";
import {
	isBaseInstance,
	isPlaypenInstance,
	sandboxFromInstance,
} from "../session/identity.ts";
import * as leases from "../session/leases.ts";
import * as store from "../session/store.ts";

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
	meta: { name: "ls", description: "List playpen sandboxes" },
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
				return {
					name: sandbox,
					status: i.status,
					used: age(meta?.lastUsed),
					att: attached === 0 ? "-" : String(attached),
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

		console.log(
			`  ${"NAME".padEnd(wName)}  ${"STATUS".padEnd(wStatus)}  ${"USED".padEnd(wUsed)}  ${"ATT".padEnd(wAtt)}  DIR`,
		);
		for (const r of rows) {
			console.log(
				`${r.pin} ${r.name.padEnd(wName)}  ${r.status.padEnd(wStatus)}  ${r.used.padEnd(wUsed)}  ${r.att.padEnd(wAtt)}  ${r.cwd}`,
			);
		}
	},
});
