import assert from "node:assert/strict";
import { test } from "node:test";
import { filterClaudeJson, filterSettings } from "./claudeconfig.ts";

const PROJECT = "/home/e/projects/api";

test("keeps account and onboarding state", () => {
  const raw = JSON.stringify({
    oauthAccount: { id: "abc" },
    hasCompletedOnboarding: true,
    userID: "u1",
    projects: {},
  });
  const out = JSON.parse(filterClaudeJson(raw, PROJECT));
  assert.deepEqual(out.oauthAccount, { id: "abc" });
  assert.equal(out.hasCompletedOnboarding, true);
  assert.equal(out.userID, "u1");
});

test("keeps only this project's entry", () => {
  const raw = JSON.stringify({
    projects: {
      [PROJECT]: { hasTrustDialogAccepted: true },
      "/home/e/projects/secret": { hasTrustDialogAccepted: true },
      "/home/e/clients/acme": { hasTrustDialogAccepted: true },
    },
  });
  const out = JSON.parse(filterClaudeJson(raw, PROJECT));
  assert.deepEqual(Object.keys(out.projects), [PROJECT]);
  assert.equal(out.projects[PROJECT].hasTrustDialogAccepted, true);
});

test("empties the map when this project is absent", () => {
  const raw = JSON.stringify({
    projects: { "/home/e/projects/other": { hasTrustDialogAccepted: true } },
  });
  const out = JSON.parse(filterClaudeJson(raw, PROJECT));
  assert.deepEqual(out.projects, {});
});

test("tolerates a missing projects key", () => {
  const out = JSON.parse(filterClaudeJson(JSON.stringify({ userID: "u1" }), PROJECT));
  assert.equal(out.userID, "u1");
  assert.equal(out.projects, undefined);
});

test("drops githubRepoPaths, which named other projects on the host", () => {
  const raw = JSON.stringify({
    userID: "u1",
    githubRepoPaths: {
      "acme/api": ["/home/e/projects/api"],
      "acme/secret": ["/home/e/projects/secret"],
    },
  });
  const out = JSON.parse(filterClaudeJson(raw, PROJECT));
  assert.equal(out.githubRepoPaths, undefined);
  assert.equal(out.userID, "u1");
});

test("drops mcpServers, whose definitions can carry tokens", () => {
  const raw = JSON.stringify({
    mcpServers: { internal: { command: "x", env: { TOKEN: "sk-live-1" } } },
  });
  assert.equal(JSON.parse(filterClaudeJson(raw, PROJECT)).mcpServers, undefined);
});

test("drops unknown keys rather than passing them through", () => {
  const raw = JSON.stringify({
    userID: "u1",
    somethingClaudeCodeAddedLastWeek: { paths: ["/home/e/clients/acme"] },
    cachedArtifactRoster: [{ title: "Q3 board deck" }],
  });
  const out = JSON.parse(filterClaudeJson(raw, PROJECT));
  assert.deepEqual(Object.keys(out), ["userID"]);
});

test("keeps preferences so the sandbox matches your terminal", () => {
  const raw = JSON.stringify({ theme: "dark", autoUpdates: false });
  const out = JSON.parse(filterClaudeJson(raw, PROJECT));
  assert.equal(out.theme, "dark");
  assert.equal(out.autoUpdates, false);
});

test("drops the account identity when credentials are not requested", () => {
  const raw = JSON.stringify({ oauthAccount: { id: "abc" }, userID: "u1", theme: "dark" });
  const out = JSON.parse(filterClaudeJson(raw, PROJECT, false));
  assert.equal(out.oauthAccount, undefined);
  assert.equal(out.userID, undefined);
  assert.equal(out.theme, "dark");
});

test("settings.json keeps its API-key settings when credentials are requested", () => {
  const raw = JSON.stringify({
    permissions: { allow: ["Bash(ls)"] },
    env: { ANTHROPIC_API_KEY: "sk-ant-live" },
    apiKeyHelper: "op read op://vault/key",
  });
  const out = JSON.parse(filterSettings(raw, true));
  assert.deepEqual(out.env, { ANTHROPIC_API_KEY: "sk-ant-live" });
  assert.equal(out.apiKeyHelper, "op read op://vault/key");
});

test("settings.json loses its API-key settings when credentials are not requested", () => {
  const raw = JSON.stringify({
    permissions: { allow: ["Bash(ls)"] },
    env: { ANTHROPIC_API_KEY: "sk-ant-live" },
    apiKeyHelper: "op read op://vault/key",
    awsAuthRefresh: "aws sso login",
    awsCredentialExport: "print-creds",
  });
  const out = JSON.parse(filterSettings(raw, false));
  assert.deepEqual(Object.keys(out), ["permissions"]);
});
