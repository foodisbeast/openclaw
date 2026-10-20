// @vitest-environment node
import { expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import {
  isSessionTitlePending,
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkContext,
  resolveSessionWorkSubtitle,
} from "./session-display.ts";

const namingKey = "agent:main:dashboard:naming";
it.each([
  [namingKey, { titlePending: true }, true],
  [namingKey, { titlePending: false }, false],
  [namingKey, {}, false],
  ["agent:main:main", { titlePending: true }, false],
] as const)("uses naming settlement for %s (%j)", (key, row, expected) => {
  expect(isSessionTitlePending(key, row)).toBe(expected);
});
it.each(["label", "displayName", "derivedTitle"] as const)("prefers a usable %s", (field) => {
  const pending = (name: string) =>
    isSessionTitlePending(namingKey, { titlePending: true, [field]: name });
  expect([pending("Release readiness"), pending("  "), pending(namingKey)]).toEqual([
    false,
    true,
    true,
  ]);
});

it("treats translated subagent prefixes as literal text", () => {
  const prefix = "Subagent [worker]:";
  const translation = vi.spyOn(i18n, "t").mockReturnValue(prefix);
  try {
    expect(
      resolveSessionDisplayName("agent:main:subagent:worker", {
        label: `${prefix} Research sources`,
      }),
    ).toBe("Research sources");
  } finally {
    translation.mockRestore();
  }
});

it.each(["main", "agent:main:main", "agent:research:main", "agent:ops-team:main"])(
  "uses the friendly main-thread name for %s",
  (key) => expect(resolveSessionDisplayName(key)).toBe("Main Session"),
);
const nameCases: Array<[string, string, Parameters<typeof resolveSessionDisplayName>[1]?]> = [
  ["agent:research:main", "Research desk", { displayName: "Research desk" }],
  ["agent:research:dashboard:main", "New session"],
  ["agent:research:main:thread", "main:thread"],
  [
    "agent:main:telegram:cards:dm:491234567890",
    "Telegram · …567890 · cards",
    { accountId: "cards" },
  ],
  [
    "agent:main:telegram:cards:direct:42",
    "Alice · cards",
    { accountId: "cards", label: "Alice · cards" },
  ],
  ["agent:main:telegram:group:-1001234567890", "Telegram Group"],
  ["agent:main:telegram:direct:12345😀67890", "Telegram · …67890"],
  [
    "agent:main:dashboard:uuid",
    "Release room",
    { label: "Release room", derivedTitle: "Quarterly launch plan" },
  ],
  [
    "agent:main:dashboard:uuid",
    "clawdbot ⎇ wt-3f2a",
    {
      worktree: { branch: "openclaw/wt-3f2a", repoRoot: "/repo/clawdbot" },
      derivedTitle: "Quarterly launch plan",
    },
  ],
  ["agent:main:node-proof-claude", "node-proof-claude"],
  ["agent:main:explicit:node-mcp-debug", "node-mcp-debug"],
  ["agent:main:explicit:model-run-0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6d", "model-run-…5c6d"],
  ["agent:main:node-fleet-4de003fbff138fcb9239c9378b2e", "node-fleet-…8b2e"],
  ["agent:main:subagent:worker", "Research sources", { label: "Research sources" }],
  ["agent:main:subagent:worker", "Research sources", { label: "Subagent: Research sources" }],
  ["agent:main:subagent:worker", "Research sources", { displayName: "Research sources" }],
  ["agent:main:subagent:worker", "Research sources", { derivedTitle: "Research sources" }],
  ["agent:main:subagent:worker", "Subagent"],
  ["agent:main:cron:daily", "Automation: Daily", { label: "Daily" }],
  ["agent:main:dashboard:task", "Subagent: explicit title", { label: "Subagent: explicit title" }],
  ["agent:main:cron:daily", "Automation: daily-report", { label: "Cron: daily-report" }],
  ["agent:main:cron:daily", "Automation: nightly", { label: "Cron Job: nightly" }],
];
it.each(nameCases)("resolves %s as %s (%j)", (key, expected, row) => {
  expect(resolveSessionDisplayName(key, row)).toBe(expected);
});

const subtitleCases: Array<[Parameters<typeof resolveSessionWorkSubtitle>[0], string?]> = [
  [
    {
      repository: {
        url: "https://github.com/openclaw/openclaw.git",
        branch: "openclaw/cloud-task",
      },
    },
    "openclaw ⎇ openclaw/cloud-task",
  ],
  [
    { worktree: { branch: "openclaw/session-ui", repoRoot: "/repo/clawdbot" } },
    "clawdbot ⎇ session-ui",
  ],
  [
    { worktree: { branch: "feature/x", repoRoot: "/repo/clawdbot" }, execNode: "macbook" },
    "clawdbot ⎇ feature/x · macbook",
  ],
  [{ execNode: "macbook" }, "macbook"],
  [{}],
];
it.each(subtitleCases)("combines repository, branch and node %#", (row, expected) => {
  expect(resolveSessionWorkSubtitle(row)).toBe(expected);
});

const repository = {
  url: "https://github.com/example/project.git",
  branch: "openclaw/feature-cloud",
};
const project = {
  kind: "project",
  name: "project",
  path: "https://github.com/example/project",
  branch: "openclaw/feature-cloud",
} as const;
const contextCases: Array<
  [Parameters<typeof resolveSessionWorkContext>[0], ReturnType<typeof resolveSessionWorkContext>]
> = [
  [
    {
      worktree: { branch: "openclaw/session-ui", repoRoot: "/repo/openclaw" },
      spawnedCwd: "/worktrees/session-ui/packages/ui",
    },
    {
      kind: "project",
      name: "openclaw",
      path: "/repo/openclaw",
      cwd: "/worktrees/session-ui/packages/ui",
      branch: "session-ui",
    },
  ],
  [
    { spawnedWorkspaceDir: "/workspaces/release-notes", spawnedCwd: "/stale/cwd" },
    { kind: "workspace", name: "release-notes", path: "/workspaces/release-notes" },
  ],
  [
    {
      execNode: "remote-node",
      execCwd: "/remote/workspace",
      spawnedWorkspaceDir: "/local/workspace",
      worktree: { branch: "openclaw/local-branch", repoRoot: "/gateway/repo" },
    },
    { kind: "workspace", name: "workspace", path: "/remote/workspace" },
  ],
  [{ execCwd: "/stale/local-routing-cwd" }, undefined],
  [
    {
      repository,
      execNode: "cloud-node",
      execCwd: "/remote/project",
      worktree: { branch: "stale-local-branch", repoRoot: "/gateway/repo" },
    },
    { ...project, cwd: "/remote/project" },
  ],
  [
    { repository, spawnedCwd: "/gateway/unrelated" },
    { ...project, cwd: undefined },
  ],
  [
    {
      repository: { ...repository, branch: "main" },
      placement: {
        state: "reclaimed",
        providerId: "example",
        profileId: "test",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 2,
        stateChangedAtMs: 2,
        remoteWorkspaceDir: "/cloud/project",
      },
      execCwd: "/gateway/stale-routing",
      spawnedCwd: "/gateway/unrelated",
    },
    { ...project, cwd: "/cloud/project", branch: "main" },
  ],
];
it.each(contextCases)("projects only authoritative workspace facts %#", (row, expected) => {
  expect(resolveSessionWorkContext(row)).toEqual(expected);
});

// Accounts qualify DMs, not groups/channels; per-peer keys use the row's channel.
it.each([
  ["telegram:group:99", "telegram"],
  ["slack:channel:C1", "slack"],
  ["telegram:cards:dm:42", "telegram"],
  ["dm:+123", "whatsapp", "whatsapp"],
  ["telegram:work:group:room", undefined],
  ["slack:acct-1:channel:C1", undefined],
  ["dm:account:group:room", undefined],
  ["direct:+123", "whatsapp", "whatsapp"],
  ["main", undefined, "telegram"],
  ["dashboard:uuid", undefined],
] as const)("classifies channel key %s", (suffix, channel, rowChannel) => {
  const expected = channel ? { channel, channelSession: true } : { channelSession: false };
  expect(resolveChannelSessionInfo(`agent:main:${suffix}`, rowChannel)).toEqual(expected);
});

it("displays device folder provenance instead of stale Gateway workspace metadata", () => {
  const row = {
    deviceFolder: { deviceId: "build-runner", path: "/srv/existing" },
    spawnedCwd: "/gateway/stale",
    worktree: { repoRoot: "/gateway/stale", branch: "main" },
  };
  expect(resolveSessionWorkContext(row)).toEqual({
    kind: "workspace",
    name: "existing",
    path: "/srv/existing",
  });
  expect(resolveSessionWorkSubtitle(row)).toBe("/srv/existing · build-runner");
});
