---
name: ns-sync
description: Set up or update namshub in this repo, the namshub block in AGENTS.md and the shared skills in .claude/skills/. Use when The Operator asks to set up or update namshub.
---

# Sync namshub

The core rules and shared skills live in `seanhealy/namshub`. One script copies
them into this repo: the core goes between the namshub markers in `AGENTS.md`
(or `CLAUDE.md` when there's no `AGENTS.md`), and the shared skills replace
every `ns-*` folder under `.claude/skills/`. The repo's own skills, without the
prefix, stay as they are. Setup is the same run on a repo that has nothing yet.

1. On a new branch, from the repo root, run the script:
   - set up already: `node .claude/skills/ns-sync/ns-sync.ts`
   - first time: `git clone --depth 1 https://github.com/seanhealy/namshub /tmp/namshub`,
     then `node /tmp/namshub/skills/ns-sync/ns-sync.ts`
2. Check the diff touches only the namshub block and `ns-*` skill folders.
   An update also removes the shared skills' old unprefixed folders and moves
   their extensions to the new names; a first setup leaves them alone.
   Anything else means the script misbehaved: stop and tell The Operator.
3. Read the new namshub block, and any synced skill this session has already
   loaded, and follow them from here: the session holds the old copies.
4. Open a pull request titled with the script's first line. Put its changes
   link in the description when it printed one.
5. On a first setup, list the repo's own rules that now repeat the core under
   "Not in this PR". Removing them is a pull request of its own.

The script needs Node 22.18 or later, which runs TypeScript directly.
