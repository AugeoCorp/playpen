import { spawn } from "node:child_process";

export interface RunOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface CaptureResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface Collected {
	code: number;
	stdout: Buffer;
	stderr: string;
}

function collect(
	cmd: string,
	args: readonly string[],
	opts: RunOptions,
	input?: string | Uint8Array,
): Promise<Collected> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, [...args], {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		if (!child.stdout || !child.stderr) {
			reject(new Error(`${cmd}: stdio pipes were not created`));
			return;
		}

		const chunks: Buffer[] = [];
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => (stderr += chunk));

		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr });
		});

		if (input !== undefined && child.stdin) {
			child.stdin.on("error", reject);
			child.stdin.end(input);
		}
	});
}

/**
 * Never rejects on a non-zero exit: "no such instance" is a normal answer from
 * limactl, so callers branch on `code` instead of catching. Only a failure to
 * spawn at all (a missing binary) rejects.
 */
export async function capture(
	cmd: string,
	args: readonly string[],
	opts: RunOptions = {},
): Promise<CaptureResult> {
	const r = await collect(cmd, args, opts);
	return { code: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr };
}

export function captureBuffer(
	cmd: string,
	args: readonly string[],
	opts: RunOptions = {},
	input?: string | Uint8Array,
): Promise<Collected> {
	return collect(cmd, args, opts, input);
}

/**
 * Write `input` to the command's stdin. Exists so secrets travel through a pipe
 * rather than argv, where `ps` shows them for the life of the process.
 */
export async function feed(
	cmd: string,
	args: readonly string[],
	input: string | Uint8Array,
	opts: RunOptions = {},
): Promise<CaptureResult> {
	const r = await collect(cmd, args, opts, input);
	return { code: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr };
}

/** Hand the terminal to the command; resolves with its exit code. */
export function attach(
	cmd: string,
	args: readonly string[],
	opts: RunOptions = {},
): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, [...args], {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});
}

export class CommandFailed extends Error {
	readonly result: CaptureResult;

	constructor(cmd: string, result: CaptureResult) {
		const detail = result.stderr.trim() || result.stdout.trim() || "no output";
		super(`${cmd} exited ${result.code}: ${detail}`);
		this.name = "CommandFailed";
		this.result = result;
	}
}

export function mustSucceed(cmd: string, result: CaptureResult): CaptureResult {
	if (result.code !== 0) throw new CommandFailed(cmd, result);
	return result;
}

/**
 * The name is passed as a positional to `command -v` rather than interpolated
 * into `sh -c`, so it can never be parsed as shell.
 */
export async function which(cmd: string): Promise<string | null> {
	try {
		const { code, stdout } = await capture("/usr/bin/env", [
			"sh",
			"-c",
			'command -v "$1"',
			"sh",
			cmd,
		]);
		return code === 0 ? stdout.trim() : null;
	} catch {
		return null;
	}
}
