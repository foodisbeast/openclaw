// Gateway assistant-avatar tests cover selected-source precedence and safe fallbacks.
import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayAssistantAvatar } from "./assistant-avatar.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";

const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG.toString("base64")}`;
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function createWorkspace(identity: { avatar?: string; emoji?: string } = {}) {
  const root = tempRoots.make("openclaw-gateway-avatar-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const cfg: OpenClawConfig = { agents: { entries: { main: { workspace, identity } } } };
  return {
    workspace,
    cfg,
    project: async () =>
      resolveGatewayAssistantAvatar({
        cfg,
        identity: await resolveAssistantIdentity({ cfg, agentId: "main" }),
      }),
  };
}

function projectSelected(avatar: string, cfg = createWorkspace().cfg) {
  return resolveGatewayAssistantAvatar({ cfg, identity: { agentId: "main", avatar, emoji: "🦞" } });
}

describe("resolveGatewayAssistantAvatar", () => {
  it("inlines the selected local file", async () => {
    const { project, workspace } = createWorkspace({ avatar: "avatar.png" });
    fs.writeFileSync(path.join(workspace, "avatar.png"), REAL_PNG);

    expect(await project()).toMatchObject({
      avatar: REAL_PNG_DATA_URL,
      resolution: { kind: "local", source: "avatar.png" },
    });
  });

  it("preserves a selected emoji over a lower-priority IDENTITY.md file", async () => {
    const { project, workspace } = createWorkspace({ emoji: "🦞" });
    fs.writeFileSync(path.join(workspace, "identity.png"), REAL_PNG);
    fs.writeFileSync(path.join(workspace, "IDENTITY.md"), "- Avatar: identity.png\n");

    expect(await project()).toEqual({ avatar: "🦞", resolution: null });
  });

  it.each([
    ["remote URL", "https://example.com/avatar.png"],
    ["data URI", REAL_PNG_DATA_URL],
  ])("preserves a selected %s", async (_name, avatar) => {
    expect(await createWorkspace({ avatar }).project()).toMatchObject({
      avatar,
      resolution: { source: avatar },
    });
  });

  it("uses a configured emoji when the selected local path is rejected", async () => {
    expect(await createWorkspace({ avatar: "missing.png", emoji: "🦞" }).project()).toEqual({
      avatar: "🦞",
      resolution: { kind: "none", reason: "missing", source: "missing.png" },
    });
  });

  it.each([
    ["unsupported_data_url", "data:text/plain,avatar"],
    ["unsupported_uri", "slack://avatar.png"],
  ])("rejects %s before local-path handling", async (reason, avatar) => {
    expect(await projectSelected(avatar)).toEqual({
      avatar: "🦞",
      resolution: { kind: "none", reason, source: avatar },
    });
  });

  it("never maps a rejected local path back to an authenticated avatar route", async () => {
    expect(await createWorkspace({ avatar: "missing.png" }).project()).toEqual({
      avatar: "A",
      resolution: { kind: "none", reason: "missing", source: "missing.png" },
    });
  });

  it("reports pinned-read rejection instead of claiming the avatar is local", async () => {
    const { project, workspace } = createWorkspace({ avatar: "avatar.png" });
    fs.writeFileSync(path.join(workspace, "original.png"), REAL_PNG);
    fs.linkSync(path.join(workspace, "original.png"), path.join(workspace, "avatar.png"));

    expect(await project()).toEqual({
      avatar: "A",
      resolution: { kind: "none", reason: "unreadable", source: "avatar.png" },
    });
  });

  it("preserves same-origin avatar routes and applies the configured base path", async () => {
    const { cfg } = createWorkspace();
    cfg.gateway = { controlUi: { basePath: "/openclaw" } };

    expect(await projectSelected("/avatar/main", cfg)).toEqual({
      avatar: "/openclaw/avatar/main",
      resolution: null,
    });
    expect(await projectSelected("/openclaw/avatar/main", cfg)).toEqual({
      avatar: "/openclaw/avatar/main",
      resolution: null,
    });
  });

  it.each(["/avatar/main/extra", "//evil.example/avatar/main", "//[", "/avatar\\main"])(
    "rejects non-canonical same-origin avatar path %s",
    async (avatar) => {
      expect(await projectSelected(avatar)).toEqual({
        avatar: "🦞",
        resolution: {
          kind: "none",
          reason: "outside_workspace",
          source: avatar,
        },
      });
    },
  );
});
