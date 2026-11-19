/** The guest can write a file of any length; no table is built past this. */
const MAX_TABLE_CELLS = 1_000_000;

/**
 * Every line of `after`, marked ` ` where `before` has it too and `+` where it
 * does not, with the lines only `before` has marked `-` where they stood. Lines
 * too many to compare are all marked `+`. A space follows each mark, so an
 * unchanged line that starts with `-` cannot pass for a removed one.
 */
export function markChanges(
	before: readonly string[],
	after: readonly string[],
): string[] {
	const width = after.length + 1;
	if ((before.length + 1) * width > MAX_TABLE_CELLS)
		return after.map((line) => `+ ${line}`);

	// How many lines the rest of `before` and the rest of `after` share, in order.
	const shared = new Uint32Array((before.length + 1) * width);
	function sharedFrom(beforeIndex: number, afterIndex: number): number {
		return shared[beforeIndex * width + afterIndex] ?? 0;
	}
	before.reduceRight(
		(below, removed, beforeIndex) => {
			const row = shared.subarray(
				beforeIndex * width,
				(beforeIndex + 1) * width,
			);
			after.reduceRight((right, added, afterIndex) => {
				const cell =
					removed === added
						? (below[afterIndex + 1] ?? 0) + 1
						: Math.max(below[afterIndex] ?? 0, right);
				row[afterIndex] = cell;
				return cell;
			}, 0);
			return row;
		},
		shared.subarray(before.length * width),
	);

	const marked: string[] = [];
	let beforeIndex = 0;
	let afterIndex = 0;
	// Each step takes at least one line until both are used up.
	Array.from({ length: before.length + after.length }).forEach(() => {
		const removed = before[beforeIndex];
		const added = after[afterIndex];
		if (removed !== undefined && removed === added) {
			marked.push(`  ${added}`);
			beforeIndex++;
			afterIndex++;
		} else if (
			removed !== undefined &&
			(added === undefined ||
				sharedFrom(beforeIndex + 1, afterIndex) >=
					sharedFrom(beforeIndex, afterIndex + 1))
		) {
			marked.push(`- ${removed}`);
			beforeIndex++;
		} else if (added !== undefined) {
			marked.push(`+ ${added}`);
			afterIndex++;
		}
	});
	return marked;
}
