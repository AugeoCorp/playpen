import { defineCommand } from "citty";
import { limaHome } from "../config.ts";
import * as lima from "../lima/client.ts";
import { isPlaypenInstance } from "../session/identity.ts";
import { capture, which } from "../sh.ts";

type Status = "ok" | "warn" | "fail";

interface Check {
	status: Status;
	label: string;
	detail: string;
}

const MARKS: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };

function checkNode(): Check {
	const stripping = (process.features as { typescript?: unknown }).typescript;
	return stripping
		? {
				status: "ok",
				label: "node",
				detail: `${process.version} runs .ts directly`,
			}
		: {
				status: "fail",
				label: "node",
				detail: `${process.version} cannot run .ts; need >=23.6 built with TypeScript support`,
			};
}

async function checkLimactl(): Promise<Check> {
	const path = await which("limactl");
	if (!path) {
		return {
			status: "fail",
			label: "limactl",
			detail: "not on PATH — install Lima",
		};
	}
	const { code, stdout } = await capture("limactl", ["--version"]);
	const version =
		code === 0 ? stdout.trim().replace(/^limactl version\s*/, "") : "unknown";
	return { status: "ok", label: "limactl", detail: `${version} at ${path}` };
}

/**
 * qcow2 on a copy-on-write filesystem is CoW-on-CoW, and VM disk IO suffers
 * for it. btrfs can opt out per directory with chattr +C, but only for files
 * created afterward, so this warns rather than fixing anything.
 */
async function checkLimaHomeFs(): Promise<Check> {
	const home = limaHome();
	const { code, stdout } = await capture("findmnt", [
		"-no",
		"FSTYPE",
		"--target",
		home,
	]);
	if (code !== 0) {
		return {
			status: "warn",
			label: "lima home",
			detail: `${home} (filesystem unknown)`,
		};
	}

	const fstype = stdout.trim();
	if (fstype !== "btrfs") {
		return { status: "ok", label: "lima home", detail: `${home} on ${fstype}` };
	}

	const attrs = await capture("lsattr", ["-d", home]);
	const nodatacow =
		attrs.code === 0 && (attrs.stdout.split(/\s+/)[0] ?? "").includes("C");
	return nodatacow
		? {
				status: "ok",
				label: "lima home",
				detail: `${home} on btrfs with nodatacow (C)`,
			}
		: {
				status: "warn",
				label: "lima home",
				detail:
					`${home} on btrfs without nodatacow — qcow2 images will suffer CoW-on-CoW. ` +
					`Consider: chattr +C on a fresh ${home}`,
			};
}

async function checkInstances(): Promise<Check> {
	let names: string[];
	try {
		names = (await lima.list()).map((i) => i.name);
	} catch {
		return {
			status: "warn",
			label: "instances",
			detail: "could not list instances",
		};
	}
	const ours = names.filter(isPlaypenInstance);
	return {
		status: "ok",
		label: "instances",
		detail:
			ours.length === 0
				? `no playpen instances (${names.length} other Lima instance(s) untouched)`
				: `${ours.length} playpen instance(s): ${ours.join(", ")}`,
	};
}

export default defineCommand({
	meta: {
		name: "doctor",
		description: "Check that the host can run playpen sandboxes",
	},
	async run() {
		const checks: Check[] = [
			checkNode(),
			await checkLimactl(),
			await checkLimaHomeFs(),
			await checkInstances(),
		];

		const width = Math.max(...checks.map((c) => c.label.length));
		for (const c of checks) {
			console.log(`${MARKS[c.status]} ${c.label.padEnd(width)}  ${c.detail}`);
		}
		if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
	},
});
