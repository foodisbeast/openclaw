import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import * as gateway from "../gateway/call.js";
import {
  completeGatewayBootLifecycle,
  beginGatewayBootLifecycle,
} from "../infra/gateway-boot-lifecycle.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { checkGatewayHealth, collectGatewayHealthFindings } from "./doctor-gateway-health.js";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  probe: vi.fn(),
  hasActiveGatewayExecCredential: vi.fn(),
  note: vi.fn(),
}));
vi.mock("../flows/doctor-gateway-exec-credential.js", () => ({
  hasActiveGatewayExecCredential: mocks.hasActiveGatewayExecCredential,
}));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: async () => null }),
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  });
});
const reason = "gateway.installation_replaced: on-disk 2026.9.5 differs from running 2026.9.4";
const installationReplacementWarning =
  "Installation replaced: on-disk 2026.9.5 differs from running 2026.9.4; draining active work.";
const completedAtMs = Date.UTC(2026, 8, 19, 12);
const historyMessage = `Previous installation replacement (${new Date(completedAtMs).toISOString()}): ${reason}`;
const historyTitle = "Previous Gateway installation replacement";
const historyFinding = {
  checkId: "core/doctor/gateway-health",
  severity: "info",
  message: historyMessage,
};
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-doctor-replacement-"));
  mocks.call.mockReset().mockResolvedValue({});
  mocks.probe.mockReset().mockResolvedValue({ url: "ws://127.0.0.1:18789" });
  vi.spyOn(gateway, "callGateway").mockImplementation(mocks.call);
  vi.spyOn(gateway, "buildGatewayProbeConnectionDetails").mockImplementation(mocks.probe);
  mocks.hasActiveGatewayExecCredential.mockReset().mockResolvedValue(false);
  mocks.note.mockReset();
  const bootId = (await beginGatewayBootLifecycle(process.env, completedAtMs - 1_000)).id;
  await completeGatewayBootLifecycle(
    bootId,
    { outcome: "planned_restart", reason },
    process.env,
    completedAtMs,
  );
  await beginGatewayBootLifecycle(process.env, completedAtMs + 1_000);
});

it.each(["normal", "lint"])("keeps %s health results after history cancellation", async (mode) => {
  const scope = new AsyncWorkScope();
  const pending = scope.run(() =>
    mode === "lint"
      ? collectGatewayHealthFindings({ cfg: {}, env: process.env })
      : checkGatewayHealth({ cfg: {}, runtime }),
  );
  scope.beginClose(new Error("History inspection deadline"));
  try {
    const result = await pending;
    const message = "Previous installation replacement unavailable: History inspection deadline";
    if (mode === "lint") {
      expect(result).toContainEqual(expect.objectContaining({ severity: "warning", message }));
    } else {
      expect(result).toMatchObject({ healthOk: true });
      expect(mocks.note).toHaveBeenCalledWith(message, historyTitle);
    }
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ method: "status" }));
  } finally {
    await scope.drain();
  }
});

it.each([true, false])("reports history independently of reachability (%s)", async (reachable) => {
  if (!reachable) {
    mocks.call.mockRejectedValue(new Error("Gateway unavailable"));
  }
  expect(await checkGatewayHealth({ cfg: {}, runtime })).toMatchObject({ healthOk: reachable });
  expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ method: "status" }));
  expect(mocks.note).toHaveBeenCalledWith(historyMessage, historyTitle);
});

it.each(["healthy", "offline", "unprepared", "exec", "replaced"] as const)(
  "preserves lint history when the current probe is %s",
  async (probe) => {
    const setup = {
      healthy: () => {},
      offline: () => mocks.call.mockRejectedValue(new Error("Gateway unavailable")),
      unprepared: () => mocks.probe.mockRejectedValue(new Error("Invalid Gateway URL")),
      exec: () => mocks.hasActiveGatewayExecCredential.mockResolvedValue(true),
      replaced: () => mocks.call.mockResolvedValue({ installationReplacementWarning }),
    };
    setup[probe]();
    const findings = await collectGatewayHealthFindings({ cfg: {}, env: process.env });
    const warning = {
      severity: "warning",
      ...(probe === "replaced"
        ? { checkId: "core/doctor/gateway-health", message: installationReplacementWarning }
        : {}),
    };
    expect(findings).toMatchObject(
      probe === "healthy" ? [historyFinding] : [historyFinding, warning],
    );
    if (probe === "unprepared" || probe === "exec") {
      expect(mocks.call).not.toHaveBeenCalled();
    }
  },
);

it.each(["normal", "lint"])("ignores local history in remote %s checks", async (mode) => {
  const cfg: OpenClawConfig = {
    gateway: { mode: "remote", remote: { url: "wss://gateway.example" } },
  };
  if (mode === "lint") {
    expect(await collectGatewayHealthFindings({ cfg })).toEqual([]);
  } else {
    await checkGatewayHealth({ cfg, runtime });
    expect(mocks.note.mock.calls.map(([, title]) => title)).not.toContain(historyTitle);
  }
});
