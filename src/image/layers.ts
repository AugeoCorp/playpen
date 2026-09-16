import { defineLayer } from "./types.ts";

export function buildTools() {
  return defineLayer({
    name: "build-tools",
    packages: [
      "ca-certificates",
      "curl",
      "git",
      "jq",
      "less",
      "ripgrep",
      "build-essential",
      "unzip",
    ],
  });
}

/** Ubuntu 26.04 packages Node 22 built without TypeScript support: runs Claude Code, not playpen's own tests. */
export function node() {
  return defineLayer({
    name: "node",
    packages: ["nodejs", "npm"],
  });
}

export function python() {
  return defineLayer({
    name: "python",
    packages: ["python3", "python3-pip", "python3-venv"],
  });
}

export function claudeCode() {
  return defineLayer({
    name: "claude-code",
    script: [
      "if command -v claude >/dev/null 2>&1; then",
      '  echo "claude already installed"',
      "else",
      "  npm install -g @anthropic-ai/claude-code",
      "fi",
    ].join("\n"),
  });
}

/**
 * Nothing in a disposable build VM reads atime, so the metadata writes it costs
 * buy nothing. No fstab edit: provision scripts re-run on every boot.
 */
export function noatime() {
  return defineLayer({
    name: "noatime",
    script: [
      "if ! findmnt -no OPTIONS / | grep -q noatime; then",
      "  mount -o remount,noatime /",
      "fi",
    ].join("\n"),
  });
}
