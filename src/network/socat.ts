import { type ChildProcess, spawn } from "node:child_process";

/**
 * socat splits an address on `:` and `,`, so any of those in a path has to be
 * escaped before it becomes part of one. Verified against socat 1.8.0.
 */
export function socatPath(path: string): string {
	return path.replace(/[\\:,!'"]/g, "\\$&");
}

/**
 * `mode=600` alone is a chmod socat applies after the bind, so the socket is
 * briefly world-connectable; `umask=077` applies to the bind itself and closes
 * that window. `mode=600` stays as a second layer, in case a socat build
 * ignores `umask`.
 */
export function unixListenAddress(path: string): string {
	return `UNIX-LISTEN:${socatPath(path)},fork,unlink-early,umask=077,mode=600`;
}

export function unixConnectAddress(path: string): string {
	return `UNIX-CONNECT:${socatPath(path)}`;
}

export function tcpListenAddress(port: number, bind = "127.0.0.1"): string {
	return `TCP-LISTEN:${port},fork,reuseaddr,bind=${bind}`;
}

export function spawnSocat(from: string, to: string): ChildProcess {
	return spawn("socat", [from, to], { stdio: "inherit" });
}
