/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { resolveSessionWorkspace } from "../../../lib/sessions/workspace.ts";
import { chatPaneHeaderSessionRow as row } from "./chat-pane-header.test-support.ts";
import { canRevealSessionWorkspace, resolveChatPaneParentSession } from "./chat-pane-header.tsx";

function expectWorkspace(
  session: Partial<GatewaySessionRow>,
  root: string | null,
  label: string | null,
  options: Omit<Parameters<typeof resolveSessionWorkspace>[0], "session"> = {},
) {
  expect(resolveSessionWorkspace({ session: row(session), ...options })).toEqual({ root, label });
}

describe("chat pane parent resolution", () => {
  it("omits unresolved and self-referential parents", () => {
    const child = row({ key: "agent:main:child", parentSessionKey: "agent:main:missing" });
    expect(resolveChatPaneParentSession(child, [child])).toBeNull();
    expect(
      resolveChatPaneParentSession({ ...child, parentSessionKey: child.key }, [child]),
    ).toBeNull();
  });
});

describe("chat pane workspace resolution", () => {
  it("uses worktree repo vocabulary with spawned cwd", () => {
    expectWorkspace(
      {
        spawnedCwd: "/tmp/worktrees/title-bar",
        worktree: { id: "wt-1", branch: "title-bar", repoRoot: "/src/openclaw" },
      },
      "/tmp/worktrees/title-bar",
      "openclaw",
    );
  });

  it("does not substitute the agent workspace for a missing worktree checkout", () => {
    expectWorkspace(
      { worktree: { id: "wt-missing", branch: "feature", repoRoot: "/src/openclaw" } },
      null,
      "openclaw",
      { agentWorkspace: "/src/default-agent-workspace", worktreePath: null },
    );
  });

  it("matches the gateway root order: spawned workspace before spawned cwd", () => {
    expectWorkspace(
      { spawnedWorkspaceDir: "/src/openclaw", spawnedCwd: "/src/openclaw/packages/nested" },
      "/src/openclaw",
      "openclaw",
    );
    // execCwd is exec-node routing state; it never overrides local facts.
    expectWorkspace(
      { execCwd: "/remote/stale", spawnedCwd: "/src/openclaw" },
      "/src/openclaw",
      "openclaw",
    );
  });

  it("prefers exec cwd and falls back to the agent workspace", () => {
    expectWorkspace({ execNode: "build-mac", execCwd: "/remote/build" }, "/remote/build", "build", {
      agentWorkspace: "/local/default",
    });
    // Local facts cannot stand in for an unavailable path on another machine.
    expectWorkspace({ execNode: "build-mac", spawnedCwd: "/local/spawned" }, null, null, {
      agentWorkspace: "/local/default",
      worktreePath: "/local/worktree",
    });
    expectWorkspace({}, "/src/openclaw", "openclaw", { agentWorkspace: "/src/openclaw" });
  });

  it("disables reveal for exec nodes, remote placement, and missing advertisement", () => {
    const cannotReveal = (overrides: Partial<Parameters<typeof canRevealSessionWorkspace>[0]>) =>
      expect(
        canRevealSessionWorkspace({
          session: row(),
          workspaceRoot: "/src/openclaw",
          methodAdvertised: true,
          hasAdminAccess: true,
          ...overrides,
        }),
      ).toBe(false);
    cannotReveal({
      session: row({ execNode: "build-mac", execCwd: "/remote/build" }),
      workspaceRoot: "/remote/build",
    });
    cannotReveal({
      session: row({ placement: { state: "requested" } as GatewaySessionRow["placement"] }),
      workspaceRoot: "/cloud/work",
    });
    cannotReveal({ methodAdvertised: false });
    cannotReveal({ hasAdminAccess: false });
  });
});
