import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const namShubRepository = "https://github.com/seanhealy/nam-shub";
const blockPattern =
	/<!-- BEGIN:nam-shub@(\w+) -->[\s\S]*?<!-- END:nam-shub -->/;
const skillPrefix = "ns-";
// The shared skills' names before the prefix, for moving a repo that synced
// them. Remove once coverlet, charles and rohl are migrated.
const unprefixedSkills = {
	"pr-review": "ns-pr-review",
	testing: "ns-testing",
	"manager-mode": "ns-manager-mode",
	"sync-nam-shub": "ns-sync",
};
// Tests run here, not in the repos the skills are copied into.
const testMarker = ".test.";

export function nsSync(repository: string, source = namShubRepository) {
	const checkout = mkdtempSync(join(tmpdir(), "nam-shub-"));
	try {
		execFileSync("git", ["clone", "--quiet", "--depth", "1", source, checkout]);
		const commit = execFileSync(
			"git",
			["-C", checkout, "rev-parse", "--short", "HEAD"],
			{ encoding: "utf8" },
		).trim();
		const core = readFileSync(join(checkout, "core.md"), "utf8");
		const previous = writeBlock(repository, core, commit);
		if (previous) {
			moveUnprefixedSkills(join(repository, ".claude"));
		}
		const skills = copySkills(
			join(checkout, "skills"),
			join(repository, ".claude", "skills"),
		);
		return { previous, commit, skills };
	} finally {
		rmSync(checkout, { recursive: true, force: true });
	}
}

function writeBlock(repository: string, core: string, commit: string) {
	const agents = join(repository, "AGENTS.md");
	const file = existsSync(agents) ? agents : join(repository, "CLAUDE.md");
	const current = existsSync(file) ? readFileSync(file, "utf8") : "";
	// Generated and replaced whole, so a repo's formatter leaves it alone.
	const block = `<!-- BEGIN:nam-shub@${commit} -->\n<!-- prettier-ignore-start -->\n\n${core.trim()}\n\n<!-- prettier-ignore-end -->\n<!-- END:nam-shub -->`;
	const previous = current.match(blockPattern)?.[1];
	const next = previous
		? current.replace(blockPattern, () => block)
		: `${`${block}\n\n${current}`.trimEnd()}\n`;
	writeFileSync(file, next);
	return previous;
}

function copySkills(from: string, to: string) {
	const synced = existsSync(to)
		? readdirSync(to).filter((name) => name.startsWith(skillPrefix))
		: [];
	synced.forEach((name) => {
		rmSync(join(to, name), { recursive: true, force: true });
	});
	const names = readdirSync(from);
	names.forEach((name) => {
		cpSync(join(from, name), join(to, name), {
			recursive: true,
			filter: (source) => !basename(source).includes(testMarker),
		});
	});
	return names;
}

function moveUnprefixedSkills(claude: string) {
	Object.entries(unprefixedSkills).forEach(([name, prefixed]) => {
		rmSync(join(claude, "skills", name), { recursive: true, force: true });
		const extension = join(claude, "extensions", "skills", name);
		const moved = join(claude, "extensions", "skills", prefixed);
		if (existsSync(extension) && !existsSync(moved)) {
			renameSync(extension, moved);
		}
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { previous, commit, skills } = nsSync(process.cwd());
	if (previous === commit) {
		console.log(`nam-shub is already at ${commit}.`);
	} else if (previous) {
		console.log(`Updated nam-shub ${previous} → ${commit}.`);
		console.log(`Changes: ${namShubRepository}/compare/${previous}...${commit}`);
	} else {
		console.log(`Added nam-shub @${commit}.`);
	}
	console.log(`Skills written: ${skills.join(", ")}`);
}
