#!/usr/bin/env bash
# Throwaway spike for PLAN step 1: does `limactl clone` share extents with the
# source or copy the qcow2, does it need a stopped source, and how long?
# Touches only playpen-spike-* instances, deleted on exit.
set -euo pipefail

BASE=playpen-spike-base
CLONE=playpen-spike-clone
LIMA_HOME="${LIMA_HOME:-$HOME/.lima}"
PROBE="$LIMA_HOME/.playpen-spike-probe"
YAML=""
TOOL=""

for n in "$BASE" "$CLONE"; do
  if limactl list --quiet 2>/dev/null | grep -qx "$n"; then
    echo "$n already exists (leftover from an earlier run?); delete it first" >&2
    exit 1
  fi
done

# Installed only once nothing pre-existing can be caught by it.
cleanup() {
  local code=$? left
  [[ -n "$YAML" ]] && rm -f "$YAML"
  rm -f "$PROBE"
  echo
  echo "== cleanup =="
  limactl delete --force "$BASE" "$CLONE" 2>/dev/null || true
  left=$(limactl list --quiet 2>/dev/null | grep -x -e "$BASE" -e "$CLONE" || true)
  if [[ -n "$left" ]]; then
    echo "STILL PRESENT, remove by hand: limactl delete --force $left" >&2
  else
    echo "no playpen-spike instances remain"
  fi
  for d in "$LIMA_HOME/$BASE" "$LIMA_HOME/$CLONE"; do
    [[ -e "$d" ]] && echo "leftover directory: $d" >&2
  done
  echo "kept: lima's image cache (shared with your real instances)"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Both paths in one invocation: compsize dedupes extents only within a single
# call, so a reflinked clone measured alone is indistinguishable from a copy.
usage() {
  case "$TOOL" in
    btrfs) btrfs filesystem du -s "$@" ;;
    compsize) compsize -x "$@" ;;
  esac
}

echo "== preflight =="
limactl clone --help >/dev/null 2>&1 || { echo "this limactl has no 'clone' subcommand" >&2; exit 1; }

# The extent ioctls may want root; find that out now, not after a 5-minute boot.
: > "$PROBE"
if command -v btrfs >/dev/null && btrfs filesystem du -s "$PROBE" >/dev/null 2>&1; then
  TOOL=btrfs          # per-path Exclusive column: the most direct readout
elif command -v compsize >/dev/null && compsize -x "$PROBE" >/dev/null 2>&1; then
  TOOL=compsize
else
  echo "no usable extent tool (btrfs fi du / compsize); would measure nothing" >&2
  exit 1
fi
rm -f "$PROBE"
# `clone` prompts to start the new instance, which would both hang a script and
# fold a full boot into the clone timing.
CLONE_FLAGS=()
if limactl clone --help 2>&1 | grep -q -- --tty; then
  CLONE_FLAGS=(--tty=false)
else
  echo "WARNING: limactl clone has no --tty flag; it may prompt and auto-start" >&2
fi
echo "limactl clone: present; extent tool: $TOOL"

YAML=$(mktemp)
cat > "$YAML" <<'YML'
base: template:_images/ubuntu
cpus: 2
memory: "2GiB"
disk: "20GiB"
mounts: []
YML

echo "== provision base (slow, once) =="
time limactl start --tty=false --name="$BASE" "$YAML"

echo "== clone a RUNNING source =="
if limactl clone "${CLONE_FLAGS[@]}" "$BASE" "$CLONE"; then
  echo "RESULT: allowed"; limactl delete --force "$CLONE"
else
  echo "RESULT: refused (fine; foundation images stay stopped)"
fi

echo "== clone a STOPPED source =="
limactl stop "$BASE"
time limactl clone "${CLONE_FLAGS[@]}" "$BASE" "$CLONE"

echo "== extent sharing, base and clone together =="
usage "$LIMA_HOME/$BASE" "$LIMA_HOME/$CLONE"

echo "== boot the clone =="
time limactl start --tty=false "$CLONE"
limactl shell "$CLONE" -- uname -a
limactl stop "$CLONE"

echo
echo "Clone Exclusive near zero (large Set shared) => reflink, retention is cheap."
echo "Clone Exclusive ~= the base image => full copy, every sandbox costs an image."
