import { createInterface } from "node:readline/promises";

/**
 * Asks on stderr so stdout stays usable for output. Fails closed without a
 * TTY: there is nobody to answer, and silence is not consent.
 */
export async function confirm(question: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question(question)).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}
