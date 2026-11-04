---
name: sync-nam-shub
description: Set up or update nam-shub in this repo, the nam-shub block in AGENTS.md and the shared skills in .claude/skills/. Use when The Operator asks to set up or update nam-shub.
---

# Sync nam-shub

The core rules and shared skills live in `seanhealy/nam-shub`. One script copies
them into this repo: the core goes between the nam-shub markers in `AGENTS.md`
(or `CLAUDE.md` when there's no `AGENTS.md`), and each shared skill replaces
its folder under `.claude/skills/`. Setup is the same run on a repo that has
nothing yet.

1. On a new branch, from the repo root, run the script:
   - set up already: `node .claude/skills/sync-nam-shub/sync-nam-shub.ts`
   - first time: `git clone --depth 1 https://github.com/seanhealy/nam-shub /tmp/nam-shub`,
     then `node /tmp/nam-shub/skills/sync-nam-shub/sync-nam-shub.ts`
2. Check the diff touches only the nam-shub block and the skill folders the
   script listed. Anything else means the script misbehaved: stop and tell
   The Operator.
3. Open a pull request titled with the script's first line. Put its changes
   link in the description when it printed one.
4. On a first setup, list the repo's own rules that now repeat the core under
   "Not in this PR". Removing them is a pull request of its own.

The script needs Node 22.18 or later, which runs TypeScript directly.
