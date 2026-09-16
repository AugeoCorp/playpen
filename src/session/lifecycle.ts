import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaults, limaHome, templatesDir } from "../config.ts";
import { ensureBase, findBase } from "../image/bake.ts";
import { baseImage } from "../image/base.ts";
import { maskScript, render, serialize } from "../image/render.ts";
import * as lima from "../lima/client.ts";
import { confirm } from "../prompt.ts";
import * as history from "./history.ts";
import { instanceName, sandboxName } from "./identity.ts";
import { checkMount } from "./mountguard.ts";
import { CONFIG_FILE, LEGACY_IGNORE_FILE } from "./projectconfig.ts";
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

async function loadMasks(sb: Sandbox): Promise<string[]> {
	const { masked, rejected, error, legacyIgnore } = await loadTrustedConfig(
		sb.cwd,
		sb.sandbox,
	);
	if (error) {
		console.error(`warning: ${CONFIG_FILE} not loaded (${error})`);
		console.error(`  continuing with no masks; everything is shared over 9p.`);
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
	if (masked.length > 0) {
		console.error(`masking with guest-local storage: ${masked.join(", ")}`);
	}
	return masked;
}

interface Template {
	yaml: string;
	hash: string;
	masks: string[];
}

/** Loads the project config, so it is read once per command and reused. */
async function renderTemplate(sb: Sandbox): Promise<Template> {
	const masks = await loadMasks(sb);
	const rendered = renderFor(sb);
	return {
		yaml: `${serialize(rendered)}\n`,
		hash: rendered.contentHash,
		masks,
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

/**
 * A clone carries the base's instance config, which Lima has resolved: `base:`
 * consumed, the concrete `images:` list spliced in. Lima rejects a config that
 * still has `base:` and no `images:`, so playpen's own rendered template cannot
 * replace it -- only the empty `mounts` the base left behind is rewritten.
 *
 * Provisioning stays skipped either way: the guard markers are on the cloned
 * disk and the image hash has not changed.
 */
async function giveCloneItsMount(sb: Sandbox): Promise<void> {
	const path = join(limaHome(), sb.instance, "lima.yaml");
	const yaml = await readFile(path, "utf8");
	const found = yaml.match(NO_MOUNTS)?.length ?? 0;
	if (found !== 1) {
		throw new Error(
			`cloned ${path} has ${found} empty \`mounts\` to fill in, expected 1`,
		);
	}
	// JSON is valid YAML in either style, and quotes the path correctly.
	const mounts = JSON.stringify([{ location: sb.cwd, writable: true }]);
	await writeFile(path, yaml.replace(NO_MOUNTS, `"mounts": ${mounts}`), "utf8");
}

/**
 * Applied on every start, because a bind mount does not survive a reboot and
 * the mask set can change without the sandbox being rebuilt.
 */
async function applyMasks(
	sb: Sandbox,
	masks: readonly string[],
): Promise<void> {
	if (masks.length === 0) return;
	const result = await lima.runScript(sb.instance, maskScript(sb.cwd, masks), {
		root: true,
	});
	if (result.code !== 0) {
		console.error(`warning: could not apply masks (${result.stderr.trim()})`);
	}
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
 * are archived across it. `up` is routine, so it asks.
 */
async function confirmRebuild(reason: string): Promise<boolean> {
	console.error(reason);
	const ok = await confirm(
		`  rebuild it now? ~10s, discards packages and masked dirs [y/N] `,
	);
	if (!ok)
		console.error(
			`  keeping it; rebuild later with: playpen rm --yes && playpen up`,
		);
	return ok;
}

export async function ensureRunning(
	sb: Sandbox,
): Promise<{ created: boolean }> {
	const existing = await lima.get(sb.instance);

	let rebuilding = false;
	let template: Template | null = null;
	if (existing) {
		template = await renderTemplate(sb);
		const reason =
			(await changedTemplate(sb, template)) ?? (await outdatedBase(sb));
		rebuilding = reason !== null && (await confirmRebuild(reason));
		if (!rebuilding) {
			if (!lima.isRunning(existing)) await lima.start(sb.instance);
			await applyMasks(sb, template.masks);
			await store.touch(sb.sandbox);
			return { created: false };
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

	// A clone that never came up is worse than no clone at all: `up` would find
	// it, see nothing stale, and try to start the broken instance forever.
	await lima.clone(base.instance, sb.instance);
	try {
		await giveCloneItsMount(sb);
		await lima.start(sb.instance);
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
	await applyMasks(sb, current.masks);
	if (await history.restore(sb.instance, sb.sandbox)) {
		console.error(`restored Claude history from the previous sandbox`);
	}

	const now = new Date().toISOString();
	await store.save({
		name: sb.sandbox,
		cwd: sb.cwd,
		created: now,
		lastUsed: now,
		imageHash: current.hash,
		baseInstance: base.instance,
	});
	return { created: true };
}

export async function stop(sb: Sandbox): Promise<void> {
	const existing = await lima.get(sb.instance);
	if (existing && lima.isRunning(existing)) await lima.stop(sb.instance);
}

/**
 * Archiving needs the guest up, so a stopped sandbox is started for it: ~10s on
 * a delete, worth it because transcripts and memory exist nowhere else. Best
 * effort throughout -- a sandbox too broken to boot must still be deletable.
 */
async function saveHistory(sb: Sandbox, running: boolean): Promise<void> {
	try {
		// No session record means creation never finished, so there is no history
		// and no reason to boot it.
		if (!running && !(await store.load(sb.sandbox))) return;
		if (!running) {
			console.error(`starting it briefly to save Claude history`);
			await lima.start(sb.instance);
		}
		await history.archive(sb.instance, sb.sandbox);
	} catch (err) {
		console.error(
			`warning: could not save Claude history (${err instanceof Error ? err.message : err})`,
		);
	}
}

export async function destroy(sb: Sandbox): Promise<void> {
	const existing = await lima.get(sb.instance);
	if (existing) {
		await saveHistory(sb, lima.isRunning(existing));
		// Re-read: saveHistory may have started it, and stopping an instance that
		// is already stopped is an error that must not block the delete.
		if (lima.isRunning(await lima.get(sb.instance)))
			await lima.stop(sb.instance, true);
		await lima.remove(sb.instance);
	}
	await store.remove(sb.sandbox);
}
