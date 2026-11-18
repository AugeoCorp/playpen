/** The guest can write a file of any length; no table is built past this. */
const MAX_TABLE_CELLS = 1_000_000;

/**
 * Every line of `after`, marked ` ` where `before` has it too and `+` where it
 * does not, with the lines only `before` has marked `-` where they stood. Lines
 * too many to compare are all marked `+`.
 */
export function markChanges(
	before: readonly string[],
	after: readonly string[],
): string[] {
	const width = after.length + 1;
	if ((before.length + 1) * width > MAX_TABLE_CELLS)
		return after.map((line) => `+${line}`);

	// How many lines the rest of `before` and the rest of `after` share, in order.
	const shared = new Uint32Array((before.length + 1) * width);
	function sharedFrom(beforeIndex: number, afterIndex: number): number {
		return shared[beforeIndex * width + afterIndex] ?? 0;
	}
	for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex--) {
		for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex--) {
			shared[beforeIndex * width + afterIndex] =
				before[beforeIndex] === after[afterIndex]
					? sharedFrom(beforeIndex + 1, afterIndex + 1) + 1
					: Math.max(
							sharedFrom(beforeIndex + 1, afterIndex),
							sharedFrom(beforeIndex, afterIndex + 1),
						);
		}
	}

	const marked: string[] = [];
	let beforeIndex = 0;
	let afterIndex = 0;
	while (beforeIndex < before.length || afterIndex < after.length) {
		const removed = before[beforeIndex];
		const added = after[afterIndex];
		if (removed !== undefined && removed === added) {
			marked.push(` ${added}`);
			beforeIndex++;
			afterIndex++;
		} else if (
			removed !== undefined &&
			(added === undefined ||
				sharedFrom(beforeIndex + 1, afterIndex) >=
					sharedFrom(beforeIndex, afterIndex + 1))
		) {
			marked.push(`-${removed}`);
			beforeIndex++;
		} else {
			marked.push(`+${added}`);
			afterIndex++;
		}
	}
	return marked;
}
