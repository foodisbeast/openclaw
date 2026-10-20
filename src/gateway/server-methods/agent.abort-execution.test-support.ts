import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { isAgentRunDirectAbortReason } from "../../agents/run-termination.js";
import {
  getRpcSource,
  getRpcSourceProjectSessionActive,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  requireValue,
  expectRecordFields,
  mockCallArg,
  invokeAgent,
  prime,
} from "./agent.test-harness.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";

const mocks = getAgentTestMocks();

function blockRun(runId: string, lateFailure = false) {
  prime();
  const finishRun = createDeferred();
  const context = makeContext();
  let acceptedEntry: RpcSourceRef | undefined;
  let capturedSignal: AbortSignal | undefined;
  mocks.agentCommand.mockImplementationOnce(async (opts: { abortSignal?: AbortSignal }) => {
    capturedSignal = opts.abortSignal;
    const entry = getRpcSource(runId);
    if (entry?.input.abortSignal === opts.abortSignal) {
      acceptedEntry = entry;
    }
    await finishRun.promise;
    if (lateFailure) {
      throw new Error("late provider failure");
    }
    return {
      payloads: [{ text: "late completion" }],
      meta: { durationMs: 1, terminalReply: { disposition: "visible", text: "late completion" } },
    };
  });
  return {
    context,
    active: () => requireValue(acceptedEntry, "active run missing"),
    signal: () => capturedSignal,
    async settle(abort: Promise<void> | undefined) {
      finishRun.resolve();
      await Promise.allSettled([abort]);
      await acceptedEntry?.input.settlement.promise;
    },
  };
}

function expectAborted(runId: string, active: RpcSourceRef, respond: ReturnType<typeof vi.fn>) {
  expect(getRpcSourceProjectSessionActive(active)).toBe(false);
  expect(getRpcSource(runId)).toBe(active);
  expect(mockCallArg(respond)).toBe(true);
  expectRecordFields(mockCallArg(respond, 0, 1), { aborted: true, runIds: [runId] });
}

export function registerAgentAbortRunExecutionTest() {
  it.for([
    { action: "chat.abort", lateFailure: false },
    { action: "chat.abort", lateFailure: true },
    { action: "/stop", lateFailure: true },
  ] as const)("settles $action (late failure: $lateFailure)", async (testCase, ctx) => {
    const { action, lateFailure } = testCase;
    const runId = "idem-abort-run";
    const run = blockRun(runId, lateFailure);
    const { context } = run;

    let abort: Promise<void> | undefined;
    try {
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      const active = run.active();
      expect(getRpcSource(runId)).toBe(active);
      expect(run.signal()?.aborted).toBe(false);

      const abortRespond = vi.fn();
      const stopOptions = {
        respond: abortRespond,
        context,
        client: null,
        isWebchatConnect: () => false,
      };
      abort =
        action === "chat.abort"
          ? handleChatAbortRequest({
              ...stopOptions,
              params: { sessionKey: "agent:main:main", runId },
              req: { type: "req", id: "abort-req", method: "chat.abort" },
            })
          : handleDirectExternalChatSend({
              ...stopOptions,
              params: {
                sessionKey: "agent:main:main",
                message: "/stop",
                idempotencyKey: "idem-late-failure-stop",
              },
              req: { type: "req", id: "stop-req", method: "chat.send" },
            });

      // Acknowledge cancellation while the raw producer remains blocked.
      await withinTest(abort, ctx.signal);
      expect(run.signal()?.aborted).toBe(true);
      expect(isAgentRunDirectAbortReason(run.signal()?.reason)).toBe(true);
      expect(active.adapter.abortStopReason).toBe(action === "chat.abort" ? "rpc" : "stop");
      expectAborted(runId, active, abortRespond);
    } finally {
      await run.settle(abort);
    }
    expect(getRpcSource(runId)).toBeUndefined();
    if (lateFailure) {
      const terminal = context.dedupe.get(`agent:${runId}`);
      expect(terminal?.ok).toBe(true);
      expect(terminal?.error).toBeUndefined();
      expectRecordFields(terminal?.payload, { runId, status: "timeout", summary: "aborted" });
    }
  });
}

export function registerAgentAbortStaleKeyExecutionTest() {
  it("chat.abort by runId allows the owner connection to use a stale session key", async (ctx) => {
    const runId = "idem-abort-stale-session-key";
    const run = blockRun(runId);
    const { context } = run;

    let abort: Promise<void> | undefined;
    try {
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        {
          context,
          reqId: runId,
          client: { ...operatorWriteCliClient(), connId: "owner-conn" },
        },
      );

      const active = run.active();
      expect(getRpcSource(runId)).toBe(active);
      expect(active.input.target?.sessionKey).toBe("agent:main:main");
      const abortRespond = vi.fn();
      abort = handleChatAbortRequest({
        params: { sessionKey: "agent:main:stale-key", runId },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-req", method: "chat.abort" },
        client: { ...operatorWriteCliClient(), connId: "owner-conn" },
        isWebchatConnect: () => false,
      });

      // Acknowledge cancellation while the raw producer remains blocked.
      await withinTest(abort, ctx.signal);
      expect(run.signal()?.aborted).toBe(true);
      expectAborted(runId, active, abortRespond);
    } finally {
      await run.settle(abort);
    }
    expect(getRpcSource(runId)).toBeUndefined();
  });
}
