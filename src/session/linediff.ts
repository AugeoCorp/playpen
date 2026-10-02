interface Edit {
	op: " " | "-" | "+";
	text: string;
	/** 1-based, of this line in `a`, or of the next line of `a` for an insertion. */
	oldNo: number;
	newNo: number;
}

const MAX_LCS_CELLS = 1_000_000;

function edits(a: readonly string[], b: readonly string[]): Edit[] {
	const width = b.length + 1;
	const common = new Uint32Array((a.length + 1) * width);
	const at = (i: number, j: number): number => common[i * width + j] ?? 0;
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			common[i * width + j] =
				a[i] === b[j]
					? at(i + 1, j + 1) + 1
					: Math.max(at(i + 1, j), at(i, j + 1));
		}
	}

	const out: Edit[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		const pos = { oldNo: i + 1, newNo: j + 1 };
		const x = a[i];
		const y = b[j];
		if (x !== undefined && x === y) {
			out.push({ op: " ", text: x, ...pos });
			i++;
			j++;
		} else if (
			x !== undefined &&
			(y === undefined || at(i + 1, j) >= at(i, j + 1))
		) {
			out.push({ op: "-", text: x, ...pos });
			i++;
		} else {
			out.push({ op: "+", text: y as string, ...pos });
			j++;
		}
	}
	return out;
}

/** GNU diff names the line before an empty range, so `-0,0` is the top of the file. */
function range(start: number, count: number): string {
	return `${count === 0 ? start - 1 : start},${count}`;
}

/**
 * The lines of a unified diff from `a` to `b`: `@@` headers, then each line
 * prefixed with ` `, `-` or `+`. Empty when they are equal; null when they
 * are too long to compare.
 */
export function unifiedDiff(
	a: readonly string[],
	b: readonly string[],
	context = 3,
): string[] | null {
	if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) return null;
	const all = edits(a, b);
	const runs: { first: number; last: number }[] = [];
	for (const [k, e] of all.entries()) {
		if (e.op === " ") continue;
		const run = runs.at(-1);
		if (run && k - run.last <= 2 * context + 1) run.last = k;
		else runs.push({ first: k, last: k });
	}

	const out: string[] = [];
	for (const { first, last } of runs) {
		const hunk = all.slice(Math.max(0, first - context), last + context + 1);
		const top = hunk[0] as Edit;
		const oldCount = hunk.filter((e) => e.op !== "+").length;
		const newCount = hunk.filter((e) => e.op !== "-").length;
		out.push(
			`@@ -${range(top.oldNo, oldCount)} +${range(top.newNo, newCount)} @@`,
		);
		for (const e of hunk) out.push(`${e.op}${e.text}`);
	}
	return out;
}

/** `b` as a diff from an empty file, so every line is marked as added. */
export function allAdded(b: readonly string[]): string[] {
	return [`@@ -0,0 +1,${b.length} @@`, ...b.map((line) => `+${line}`)];
}
