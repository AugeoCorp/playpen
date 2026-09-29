import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaults, limaHome, templatesDir } from "../config.ts";
import { replaceDurably } from "../fs.ts";
import { ensureBase, findBase } from "../image/bake.ts";
import { baseImage } from "../image/base.ts";
import { maskScript, render, serialize } from "../image/render.ts";
import * as lima from "../lima/client.ts";
import { bringUp, fenceStatus, liveHelper } from "../network/fence.ts";
import {
	BUILTIN_ALLOW,
	NO_EGRESS_ADVICE,
	type Policy,
} from "../network/policy.ts";
import { confirm } from "../prompt.ts";
import * as history from "./history.ts";
import { instanceName, sandboxName } from "./identity.ts";
import * as leases from "./leases.ts";
import { withLock } from "./lock.ts";
import { checkMount } from "./mountguard.ts";
import {
	CONFIG_FILE,
	LEGACY_IGNORE_FILE,
	type LoadedNetwork,
} from "./projectconfig.ts";
import * as store from "./store.ts";
import { loadTrustedConfig } from "./trust.ts";

export interface Sandbox {
	sandbox: string;
	instance: string;
	cwd: string;
}

/**
 * Keyed on the real path: on Fedora-derived hosts /home/<user> is a symlink to
 * /var/home/<user>, and the two spellings must not yield two sandboxes.
 */
export async function identify(cwd: string): Promise<Sandbox> {
	const real = await realpath(cwd);
	const sandbox = sandboxName(real);
	return { sandbox, instance: instanceName(sandbox), cwd: real };
}

function templatePath(sb: Sandbox): string {
	return join(templatesDir(), `${sb.sandbox}.yaml`);
}

function renderFor(sb: Sandbox) {
	return render(baseImage, { ...defaults, mount: sb.cwd });
}

async function loadConfig(sb: Sandbox): Promise<{
	masked: string[];
	setup: string[];
	network: LoadedNetwork;
}> {
	const {
		masked,
		setup,
		network,
		rejected,
		rejectedSetup,
		rejectedNetwork,
		error,
		legacyIgnore,
	} = await loadTrustedConfig(sb.cwd, sb.sandbox);
	if (error) {
		console.error(`warning: ${CONFIG_FILE} not loaded (${error})`);
		console.error(
			`  continuing with no masks and no setup; everything is shared over 9p.`,
		);
	}
	if (legacyIgnore) {
		console.error(
			`warning: ${LEGACY_IGNORE_FILE} is no longer read. Move its entries to`,
		);
		console.error(
			`  ${CONFIG_FILE}: export default { masked: ["node_modules"] }`,
		);
	}
	for (const bad of rejected) {
		console.error(`warning: ignoring invalid \`masked\` entry: ${bad}`);
	}
	for (const bad of rejectedSetup) {
		console.error(`warning: ignoring invalid \`setup\` entry: ${bad}`);
	}
	for (const bad of rejectedNetwork) {
		console.error(`warning: ignoring invalid \`network.allow\` entry: ${bad}`);
	}
	if (network.mode === "log") {
		console.error(
			`warning: network blocking is off for this project (\`network.mode\` is "log")`,
		);
		console.error(`  connections are recorded and allowed.`);
	}
	if (masked.length > 0) {
		console.error(`masking with guest-local storage: ${masked.join(", ")}`);
	}
	const hosts = network.allow.length;
	if (hosts > 0) {
		console.error(
			`allowing network access to ${hosts === 1 ? "1 host" : `${hosts} hosts`} named by this project`,
		);
	}
	for (const { host, guest } of network.ports) {
		console.error(
			`forwarding host port ${host} to the guest's localhost:${guest}`,
		);
	}
	for (const { env, hosts } of network.secrets) {
		console.error(`naming ${env} for ${hosts.join(", ")} (not injected yet)`);
	}
	return { masked, setup, network };
}

/**
 * Must run after `applyMasks`: a mask is a bind mount over a directory inside
 * the project, so an install that ran first would write to the 9p share and
 * then be shadowed by the mount.
 *
 * Through a login shell rather than argv, against the rule elsewhere, because
 * an entry may use `&&` or redirection and because a login shell is what
 * activates mise -- otherwise an install uses the floor toolchain instead of
 * the one the project pinned.
 */
export async function runSetup(
	sb: Sandbox,
	setup: readonly string[],
): Promise<boolean> {
	for (const command of setup) {
		console.error(`setup: ${command}`);
		// stdin is the caller's: a step that prompts would hang `playpen run`,
		// and one that reads would eat input meant for the command after it.
		const code = await lima.shell(sb.instance, sb.cwd, [
			"bash",
			"-lc",
			`exec </dev/null; ${command}`,
		]);
		if (code !== 0) {
			console.error(`warning: setup step failed (exit ${code}): ${command}`);
			console.error(`  remaining steps skipped; re-run with: playpen setup`);
			return false;
		}
	}
	return true;
}

interface Template {
	yaml: string;
	hash: string;
	masks: string[];
	setup: string[];
	network: LoadedNetwork;
}

/** Loads the project config, so it is read once per command and reused. */
async function renderTemplate(sb: Sandbox): Promise<Template> {
	const { masked, setup, network } = await loadConfig(sb);
	const rendered = renderFor(sb);
	return {
		yaml: `${serialize(rendered)}\n`,
		hash: rendered.contentHash,
		masks: masked,
		setup,
		network,
	};
}

async function writeTemplate(sb: Sandbox, template: Template): Promise<void> {
	await mkdir(templatesDir(), { recursive: true });
	// .yaml extension with JSON content: JSON is valid YAML, and Lima keys off the extension.
	await writeFile(templatePath(sb), template.yaml, "utf8");
}

/**
 * What `renderBase` leaves empty for a sandbox to fill in. Quoted or not, and
 * flow or block style, because this matches what Lima re-emitted rather than
 * what playpen wrote. Provision scripts share the same line as escaped strings,
 * so the count is checked below rather than trusting the first match.
 */
const NO_MOUNTS = /"?mounts"?\s*:\s*\[\s*\]/g;

function mountsFor(sb: Sandbox): string {
	// JSON is valid YAML in either style, and quotes the paths correctly.
	return `"mounts": ${JSON.stringify([
		{ location: sb.cwd, writable: true },
		{
			location: history.hostDir(sb.sandbox),
			mountPoint: history.GUEST_MOUNT_POINT,
			writable: true,
		},
	])}`;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What a sandbox created before the history mount was given: compact JSON in
 * a clone's lima.yaml, and pretty-printed in one made before bases existed,
 * which is playpen's own rendered template verbatim.
 */
function projectOnlyMounts(sb: Sandbox): RegExp {
	const location = escapeRegExp(JSON.stringify(sb.cwd));
	return new RegExp(
		`"mounts"\\s*:\\s*\\[\\s*\\{\\s*"location"\\s*:\\s*${location}\\s*,\\s*"writable"\\s*:\\s*true\\s*\\}\\s*\\]`,
		"g",
	);
}

function limaYaml(sb: Sandbox): string {
	return join(limaHome(), sb.instance, "lima.yaml");
}

/**
 * False for a sandbox that may still hold Claude history on its own disk,
 * whatever its lima.yaml says: one made before the history mount, until a
 * start has moved that history to the host and checked it there.
 */
export function historyOnHost(sb: Sandbox): Promise<boolean> {
	return history.onHost(sb.instance);
}

/**
 * A clone carries the base's instance config, which Lima has resolved: `base:`
 * consumed, the concrete `images:` list spliced in. Lima rejects a config that
 * still has `base:` and no `images:`, so playpen's own rendered template cannot
 * replace it -- only the `mounts` the base left empty is rewritten.
 *
 * A sandbox made before the history mount existed has the project's mount
 * alone, which playpen wrote and so can match exactly. It gets the history
 * mount here too, in place, on its next boot: Lima reads lima.yaml on every
 * start. Its rendered template is left as it was, so `changedTemplate` does
 * not offer a rebuild for this -- a rebuild would delete the guest's own copy
 * of its history before the mount could take it over.
 *
 * Provisioning stays skipped either way: the guard markers are on the cloned
 * disk and the image hash has not changed.
 */
async function giveInstanceItsMounts(sb: Sandbox): Promise<void> {
	const path = limaYaml(sb);
	const yaml = await readFile(path, "utf8");
	const mounts = mountsFor(sb);
	if (yaml.includes(mounts)) return;
	const empty = yaml.match(NO_MOUNTS)?.length ?? 0;
	const projectOnly = yaml.match(projectOnlyMounts(sb))?.length ?? 0;
	if (empty + projectOnly !== 1) {
		throw new Error(
			`${path} has ${empty + projectOnly} \`mounts\` playpen wrote to fill in, expected 1`,
		);
	}
	const filled =
		empty === 1
			? yaml.replace(NO_MOUNTS, () => mounts)
			: yaml.replace(projectOnlyMounts(sb), () => mounts);
	await replaceDurably(path, filled);
}

/**
 * Not fatal: the sandbox still works, with Claude history kept in the guest as
 * before. Said, because that history is now lost when the sandbox is removed.
 */
async function mountHistoryOnExisting(sb: Sandbox): Promise<void> {
	try {
		await giveInstanceItsMounts(sb);
	} catch (err) {
		console.error(
			`warning: Claude history is not mounted from the host (${err instanceof Error ? err.message : err})`,
		);
		console.error(
			`  it stays on the VM's disk; \`playpen remove --yes --discard-history\` deletes it with the VM`,
		);
	}
}

/**
 * Applied on every start, because a bind mount does not survive a reboot and
 * the mask set can change without the sandbox being rebuilt.
 */
async function applyMasks(
	sb: Sandbox,
	masks: readonly string[],
): Promise<boolean> {
	if (masks.length === 0) return true;
	const result = await lima.runScript(sb.instance, maskScript(sb.cwd, masks), {
		root: true,
	});
	if (result.code !== 0) {
		console.error(`warning: could not apply masks (${result.stderr.trim()})`);
		return false;
	}
	return true;
}

/**
 * Lima boots an existing instance from its own stored lima.yaml, so edits to
 * the image definition or the project config do not reach it. Comparing
 * against the template written at creation catches both.
 */
async function changedTemplate(
	sb: Sandbox,
	current: Template,
): Promise<string | null> {
	let previous: string;
	try {
		previous = await readFile(templatePath(sb), "utf8");
	} catch {
		return null;
	}
	if (current.yaml === previous) return null;
	return `the image or ${CONFIG_FILE} changed since this sandbox was created.`;
}

/**
 * A rebaked base has the same image hash, so the rendered template is
 * identical and the comparison above cannot see it. Without this, `image build
 * --force` would leave every existing sandbox on the old packages with nothing
 * to say so.
 */
async function outdatedBase(sb: Sandbox): Promise<string | null> {
	const meta = await store.load(sb.sandbox);
	// Sandboxes created before bases existed have nothing to compare.
	if (!meta?.baseInstance) return null;
	const newest = await findBase();
	if (newest === null || newest === meta.baseInstance) return null;
	return `a newer base image exists: ${newest} (this one came from ${meta.baseInstance}).`;
}

/**
 * Offered rather than done: a reclone is ~10s, but the guest disk goes with it
 * -- installed packages and masked directories. Claude transcripts and memory
 * are on the host and stay. `start` is routine, so it asks.
 */
async function confirmRebuild(reason: string): Promise<boolean> {
	console.error(reason);
	const ok = await confirm(
		`  rebuild it now? ~10s, discards packages and masked dirs [y/N] `,
	);
	if (!ok)
		console.error(
			`  keeping it; rebuild later with: playpen remove --yes && playpen start`,
		);
	return ok;
}

export interface Running {
	created: boolean;
	/** False when a step failed, or when setup was skipped because masks were not applied. */
	setupOk: boolean;
	/** The project's steps, so `playpen setup` re-runs them without a second trust pass. */
	setup: string[];
}

/**
 * Starts the VM inside its network fence, so every connection out of the guest
 * arrives at the gatekeeper. Every start of a sandbox goes through `bringUp`;
 * the one VM started any other way is the base image while it is baked
 * (image/bake.ts), which has no project policy to apply and nothing running
 * in it but the build.
 */
async function startFenced(sb: Sandbox, template: Template): Promise<void> {
	const { allow, mode, ports, secrets } = template.network;
	await fenced(sb, {
		// A port or a secret's host is a grant, so writing it once is enough.
		allow: [
			...BUILTIN_ALLOW,
			...allow,
			...ports.map(({ host }) => `localhost:${host}`),
			...secrets.flatMap(({ hosts }) => hosts),
		],
		mode,
		ports,
		secrets,
	});
	await warnWithoutEgress(sb);
	await warnUnboundPorts(sb);
}

function fenced(sb: Sandbox, policy: Policy): Promise<void> {
	return bringUp({
		sandbox: sb.sandbox,
		instance: sb.instance,
		policy,
		log: (text) => process.stderr.write(text),
	});
}

/**
 * The fence came up and the guest still cannot reach the gatekeeper, so the
 * sandbox has no network at all. Said here rather than left in helper.log,
 * which nobody reads when the command it belongs to succeeded.
 */
async function warnWithoutEgress(sb: Sandbox): Promise<void> {
	const helper = await liveHelper(sb.sandbox);
	if (helper === null || helper.egress) return;
	console.error(`warning: ${sb.sandbox} has no network`);
	for (const line of NO_EGRESS_ADVICE) console.error(`  ${line}`);
}

/**
 * Not a failed start: everything else about the sandbox works, and a client
 * pointed at that port in the guest reaches whatever holds it, not the host.
 */
async function warnUnboundPorts(sb: Sandbox): Promise<void> {
	const helper = await liveHelper(sb.sandbox);
	for (const { host, guest } of helper?.unboundPorts ?? []) {
		console.error(
			`warning: host port ${host} is not at the guest's localhost:${guest}; nothing could listen there`,
		);
		console.error(
			`  the guest already uses port ${guest}, or has no socat (rebuild the sandbox)`,
		);
		console.error(
			`  pick another guest port in \`network.ports\` if it is taken`,
		);
	}
}

export async function ensureRunning(sb: Sandbox): Promise<Running> {
	const existing = await lima.get(sb.instance);

	let rebuilding = false;
	let template: Template | null = null;
	if (existing) {
		template = await renderTemplate(sb);
		const reason =
			(await changedTemplate(sb, template)) ?? (await outdatedBase(sb));
		if (reason !== null && !(await historyOnHost(sb))) {
			console.error(reason);
			console.error(
				`  no rebuild is offered until its Claude history is safely on the host; a start with the history directory mounted moves it there`,
			);
		} else {
			rebuilding = reason !== null && (await confirmRebuild(reason));
		}
		if (!rebuilding) {
			const fence = lima.isRunning(existing)
				? await fenceStatus(sb.sandbox, sb.instance)
				: "stopped";
			// Started by hand with limactl, so its egress is unfiltered. There is no
			// unfenced mode to attach to; the fix is a restart through playpen.
			if (fence === "unsealed") {
				throw new Error(
					`${sb.instance} is running outside its network fence.\n` +
						`  stop it and start it again: playpen stop --force && playpen start`,
				);
			}
			const booting = !lima.isRunning(existing);
			if (booting) {
				await history.makeHostDir(sb.sandbox);
				await mountHistoryOnExisting(sb);
			}
			// In every other state, including a sandbox that is already up: a
			// stopped VM is started, one that survived its helper gets another
			// gatekeeper, and a running one has its policy rewritten, which is
			// what its helper reads to decide on -- so a list tightened since it
			// started takes effect without a restart.
			await startFenced(sb, template);
			await applyMasks(sb, template.masks);
			await history.settle(sb.instance, sb.sandbox, booting);
			await store.touch(sb.sandbox);
			return { created: false, setupOk: true, setup: template.setup };
		}
	}

	// Only checked when a sandbox is about to be built, and before the old one is
	// torn down: destroying a sandbox and then refusing to replace it is worse
	// than either outcome alone.
	const guard = await checkMount(sb.cwd);
	if (!guard.ok) throw new Error(guard.reason ?? `refusing to mount ${sb.cwd}`);
	if (guard.warning) console.error(`warning: ${guard.warning}`);

	if (rebuilding) await destroy(sb);

	const current = template ?? (await renderTemplate(sb));
	await writeTemplate(sb, current);

	const base = await ensureBase();
	if (base.built) console.error(`baked base image ${base.instance}`);

	// A clone that never came up is worse than no clone at all: `start` would find
	// it, see nothing stale, and try to start the broken instance forever.
	await lima.clone(base.instance, sb.instance);
	try {
		await history.makeHostDir(sb.sandbox);
		await giveInstanceItsMounts(sb);
		await startFenced(sb, current);
	} catch (err) {
		await lima
			.remove(sb.instance)
			.catch(() =>
				console.error(
					`warning: could not remove the failed clone ${sb.instance}`,
				),
			);
		throw err;
	}
	const masked = await applyMasks(sb, current.masks);
	await history.settle(sb.instance, sb.sandbox, true);

	// Recorded before setup, not after: setup can run for minutes, and an
	// instance that exists with no record is one `start` will neither finish nor
	// offer to rebuild.
	const now = new Date().toISOString();
	await store.save({
		name: sb.sandbox,
		cwd: sb.cwd,
		created: now,
		lastUsed: now,
		imageHash: current.hash,
		baseInstance: base.instance,
	});

	// Not on every start, so `run` and `shell` stay fast. A rebuild reaches here
	// too, which is the case that needs it most: the guest disk went with it.
	const setupOk = masked
		? await runSetup(sb, current.setup)
		: skipSetup(current.setup);
	return { created: true, setupOk, setup: current.setup };
}

/**
 * Masks failed, so the paths setup would write to are still the host's. Running
 * an install now would replace the host's contents with the guest's build of
 * them, which is the thing masking exists to prevent.
 */
function skipSetup(setup: readonly string[]): boolean {
	if (setup.length === 0) return true;
	console.error(`warning: skipping setup because masks were not applied`);
	console.error(`  it would install into the host directory. fix, then:`);
	console.error(`  playpen setup`);
	return false;
}

/**
 * Run `fn` with the sandbox up and a lease held, then stop it only if no other
 * session is still attached.
 *
 * Acquiring and releasing both happen under the lock, so a session arriving
 * while another is deciding to stop is either counted or starts the VM itself.
 * `fn` runs outside it -- it lasts as long as the agent does.
 */
export async function attached<T>(
	sb: Sandbox,
	stopAfter: boolean,
	fn: (running: Running) => Promise<T>,
): Promise<T> {
	// Captured outside the callback so a throw from `ensureRunning` -- a
	// mount-guard refusal, a failed clone -- still releases the lease rather than
	// leaving one behind for the next read to reap.
	let owner: leases.Owner | null = null;
	const running = await withLock(
		sb.sandbox,
		async () => {
			owner = await leases.acquire(sb.sandbox);
			return ensureRunning(sb);
		},
		{
			waiting: () =>
				console.error(
					`waiting for another playpen to release ${sb.sandbox}...`,
				),
		},
	).catch(async (err: unknown) => {
		await release(sb, owner, false);
		throw err;
	});

	try {
		return await fn(running);
	} finally {
		await release(sb, owner, stopAfter);
	}
}

/** Drop our lease, and stop the sandbox only if we held the last one. */
async function release(
	sb: Sandbox,
	owner: leases.Owner | null,
	stopAfter: boolean,
): Promise<void> {
	await withLock(sb.sandbox, async () => {
		if (owner) await leases.release(sb.sandbox, owner);
		if (!stopAfter) return;
		const others = await leases.live(sb.sandbox);
		if (others.length > 0) {
			console.error(
				`leaving ${sb.sandbox} running; ${others.length} other session${others.length === 1 ? "" : "s"} attached`,
			);
			return;
		}
		await stop(sb);
	});
}

export async function stop(sb: Sandbox): Promise<void> {
	const existing = await lima.get(sb.instance);
	if (existing && lima.isRunning(existing)) await lima.stop(sb.instance);
}

const MOVE_HISTORY_FIRST = [
	"run `playpen start` once to move it to the host (with `playpen stop` first if",
	"  it has been running since before the history mount), or pass",
	"  --discard-history to delete it with the VM",
].join("\n");

/** For the `remove` prompt: what happens to Claude history if it goes ahead. */
export async function historyNotice(sb: Sandbox): Promise<string> {
	if (!(await lima.get(sb.instance)) || (await historyOnHost(sb)))
		return "Claude transcripts and memory are on the host and stay for the next start.";
	return `Claude transcripts and memory may still be on the VM's disk only;\n  ${MOVE_HISTORY_FIRST}.`;
}

/**
 * Refuses a VM whose disk may still hold history the host has not got, unless
 * told to discard it: the one step that deletes a disk is the one that checks.
 * Nothing here boots it to find out.
 */
export async function destroy(
	sb: Sandbox,
	opts: { discardHistory?: boolean } = {},
): Promise<void> {
	const existing = await lima.get(sb.instance);
	if (existing) {
		if (!opts.discardHistory && !(await historyOnHost(sb)))
			throw new Error(
				`${sb.sandbox} may still hold Claude history on its disk that is not on the host.\n  ${MOVE_HISTORY_FIRST}.`,
			);
		if (lima.isRunning(existing)) await lima.stop(sb.instance, true);
		await lima.remove(sb.instance);
	}
	await store.remove(sb.sandbox);
}
