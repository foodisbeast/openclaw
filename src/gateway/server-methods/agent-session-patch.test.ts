import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import {
  mergeSessionEntry,
  resolveSessionResetPolicy,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import * as transcriptReader from "../../config/sessions/session-transcript-anchor-read.js";
import { buildAgentSessionPatch } from "./agent-session-patch.js";

beforeEach(() => {
  const read = transcriptReader.readSessionTranscriptAnchorsAsync;
  vi.spyOn(transcriptReader, "readSessionTranscriptAnchorsAsync").mockImplementation((...args) =>
    args[1].includeMetadata
      ? Promise.resolve({
          anchors: [],
          metadata: { present: true, observedAt: null, updatedAt: null },
        })
      : read(...args),
  );
});
afterEach(() => vi.restoreAllMocks());

function buildCreationPatch(opts: Partial<Parameters<typeof buildAgentSessionPatch>[0]>) {
  return buildAgentSessionPatch({
    freshEntry: opts.freshEntry,
    initialEntry: opts.freshEntry,
    cfg: {},
    sessionAgentId: "main",
    canonicalSessionKey: "agent:main:incident-42",
    storePath: "/tmp/openclaw-explicit-session-name-test.json",
    normalizedSpawned: {},
    requestDeliveryHint: undefined,
    expectedExistingSessionId: opts.freshEntry?.sessionId,
    hasRestoredCronContinuation: false,
    resetPolicy: resolveSessionResetPolicy({ resetType: "direct" }),
    now: 1_000,
    isSystemGatewayRun: false,
    visibleRequest: true,
    fallbackSessionId: "fallback",
    touchInteraction: false,
    ...opts,
  });
}

async function buildPatch(
  touchInteraction: boolean,
  opts?: { requestLabel?: string; label?: string },
) {
  const entry: SessionEntry = {
    sessionId: "session",
    updatedAt: 1_000,
    lifecycleRunId: "completed-run",
    lastRunId: "completed-run",
    status: "failed",
    agentStatus: { note: "Need a password", attention: "key", expiresAt: 61_000 },
    ...(opts?.label ? { label: opts.label } : {}),
  };
  return (
    await buildCreationPatch({
      freshEntry: entry,
      ...(opts?.requestLabel ? { requestLabel: opts.requestLabel } : {}),
      canonicalSessionKey: "agent:main:main",
      storePath: "/tmp/openclaw-agent-status-test.json",
      isSystemGatewayRun: true,
      touchInteraction,
    })
  ).patch;
}

describe("agent session patch", () => {
  it("clears agent status at the next human interaction boundary", async () => {
    const patch = await buildPatch(true);
    expect(Object.hasOwn(patch, "agentStatus")).toBe(true);
    expect(patch.agentStatus).toBeUndefined();
    expect(Object.hasOwn(patch, "lifecycleRunId")).toBe(true);
    expect(patch.lifecycleRunId).toBeUndefined();
    expect(patch.lastRunId).toBeUndefined();
  });

  it("preserves a recovery reservation while reusing a session with a failed outcome", async () => {
    const entry: SessionEntry = {
      sessionId: "recovering-session",
      updatedAt: 1_000,
      status: "failed",
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "recovery-run",
      mainRestartRecovery: {
        cycleId: "recovery-cycle",
        revision: 2,
        chargedAttempts: 1,
        reservation: { runId: "recovery-run", lifecycleGeneration: "generation-1", attempt: 1 },
      },
    };
    const { patch } = await buildCreationPatch({ freshEntry: entry, isSystemGatewayRun: true });
    const merged = mergeSessionEntry(entry, patch);

    expect(
      transitionMainSessionRecovery(merged, {
        kind: "validate_recovery",
        lifecycleGeneration: "generation-1",
        runId: "recovery-run",
        sessionId: entry.sessionId,
      }),
    ).toEqual({ kind: "recovery_validated" });
    expect(merged).toMatchObject({
      status: "failed",
      abortedLastRun: true,
      mainRestartRecovery: entry.mainRestartRecovery,
    });
  });

  // Public agent RPC labels retain their run-start contract; native spawn labels are creation-owned.
  it("persists the request label at run start", async () => {
    expect((await buildPatch(false, { requestLabel: "Fix flaky auth test" })).label).toBe(
      "Fix flaky auth test",
    );
  });

  it("keeps the existing label when the request has none", async () => {
    const patch = await buildPatch(false, { label: "Existing" });
    expect(patch.label).toBe("Existing");
    expect(Object.hasOwn(patch, "agentStatus")).toBe(false);
  });

  it("does not name an existing session", async () => {
    const entry: SessionEntry = {
      sessionId: "existing",
      updatedAt: 1_000,
      displayName: "Existing display name",
    };
    const result = await buildCreationPatch({
      explicitSessionKey: "agent:main:incident-42",
      freshEntry: entry,
    });

    expect(result.patch).not.toHaveProperty("displayName");
    expect(mergeSessionEntry(entry, result.patch).displayName).toBe(entry.displayName);
  });

  it.each([
    { name: "explicit key", key: "agent:main:incident-42", displayName: "incident-42" },
    { name: "defaulted main", key: "agent:main:main", defaulted: true },
    { name: "invisible run", key: "agent:main:internal:probe", invisible: true },
    { name: "subagent", key: "agent:main:subagent:worker-1" },
    { name: "ACP", key: "agent:main:acp:thread-1" },
  ])("derives the display name for $name", async ({ key, displayName, defaulted, invisible }) => {
    const { patch } = await buildCreationPatch({
      canonicalSessionKey: displayName ? `${key} ` : key,
      explicitSessionKey: defaulted ? undefined : key,
      visibleRequest: !invisible,
    });
    if (displayName) {
      expect(patch.displayName).toBe(displayName);
    } else {
      expect(patch).not.toHaveProperty("displayName");
    }
  });
});
