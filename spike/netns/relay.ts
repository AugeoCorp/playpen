#!/usr/bin/env node
// Carries connections across a network namespace boundary. A socket file
// crosses it because the filesystem was never unshared; a packet cannot.
//
//   relay.ts tcp-to-unix <port> <socket>   listen on loopback, hand off to the file
//   relay.ts unix-to-tcp <socket> <port>   listen on the file, hand off to loopback

import { rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";

function splice(a: Socket, b: Socket): void {
	a.pipe(b);
	b.pipe(a);
	const drop = () => {
		a.destroy();
		b.destroy();
	};
	a.on("error", drop);
	b.on("error", drop);
	a.on("close", drop);
	b.on("close", drop);
}

function tcpToUnix(port: number, socketPath: string): void {
	createServer((client) => splice(client, connect(socketPath))).listen(
		port,
		"127.0.0.1",
		() => console.log(`relay 127.0.0.1:${port} -> ${socketPath}`),
	);
}

function unixToTcp(socketPath: string, port: number): void {
	// A socket file outlives the process that bound it, so a stale one would
	// fail the bind with EADDRINUSE while nobody is listening on it.
	rmSync(socketPath, { force: true });
	createServer((client) => splice(client, connect(port, "127.0.0.1"))).listen(
		socketPath,
		() => console.log(`relay ${socketPath} -> 127.0.0.1:${port}`),
	);
}

const [mode, first, second] = process.argv.slice(2);
if (mode === "tcp-to-unix" && first && second) {
	tcpToUnix(Number(first), second);
} else if (mode === "unix-to-tcp" && first && second) {
	unixToTcp(first, Number(second));
} else {
	console.error(
		"usage: relay.ts tcp-to-unix <port> <socket> | unix-to-tcp <socket> <port>",
	);
	process.exit(2);
}
