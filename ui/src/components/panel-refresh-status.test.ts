/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { describe, expect, it } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
} from "./panel-refresh-status.ts";
import { PanelRefreshStatus } from "./solid/panel-refresh-status.tsx";

const connected: ApplicationGatewaySnapshot = {
  phase: "connected",
  client: null,
  offlineStable: false,
  hello: null,
  canvasPluginSurfaceUrl: null,
  assistantAgentId: null,
  sessionKey: "agent:main:main",
  lastError: null,
  lastErrorCode: null,
};

function renderStatus(
  status: Parameters<typeof PanelRefreshStatus>[0]["status"],
  errorMessage?: string,
) {
  return mountSolid(() => createComponent(PanelRefreshStatus, { status, errorMessage })).container;
}

describe("panel refresh failures", () => {
  it.each(["gateway-suspending", "gateway-restarting", "startup-sidecars"])(
    "keeps stale data without a callout for %s until refreshed",
    (reason) => {
      const error = new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Temporarily unavailable",
        retryable: true,
        details: { reason },
      });
      const status = failPanelRefresh(completePanelRefresh(), error, connected);
      const container = renderStatus(status, "Could not load details");
      expect(container.textContent).toBe("");
      expect(status).toMatchObject({
        error: null,
        hasLoaded: true,
        stale: true,
        awaitingGateway: true,
      });
      expect(beginPanelRefresh(status).awaitingGateway).toBe(true);
      expect(completePanelRefresh().awaitingGateway).toBe(false);
    },
  );

  it.each([
    { phase: "reconnecting" as const },
    { restartPending: true },
    { suspensionPhase: "preparing" as const },
    { suspensionPhase: "draining" as const },
    { suspensionPhase: "prepared" as const },
  ])("parks plain transport errors while unavailable: %j", (state) => {
    const status = failPanelRefresh(completePanelRefresh(), new Error("Transport failed"), {
      ...connected,
      ...state,
    });
    const container = renderStatus(status);
    expect(container.textContent).toBe("");
    expect(status).toMatchObject({ error: null, stale: true, awaitingGateway: true });
  });

  it.each([
    [{}, "UNAVAILABLE", "Catalog service failed"],
    [{ suspensionPhase: "accepting" }, "UNAVAILABLE", "Catalog service failed"],
    [{ suspensionPhase: "draining" }, "INVALID_REQUEST", 'unknown agent id "main"'],
    [{ restartPending: true }, "INVALID_REQUEST", 'unknown agent id "main"'],
  ] as const)(
    "shows hard failures and retained-data status without a Retry button (%j)",
    (state, code, message) => {
      const error = new GatewayRequestError({ code, message });
      const status = failPanelRefresh(completePanelRefresh(), error, {
        ...connected,
        ...state,
      });
      const container = renderStatus(status);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
      expect(container.textContent).toContain("Showing stale data");
      expect(container.querySelector("button")).toBeNull();
      expect(status.awaitingGateway).toBe(false);
    },
  );

  it("does not classify lifecycle words in an ordinary error message", () => {
    const status = failPanelRefresh(
      createPanelRefreshStatus(),
      new Error("gateway-suspending"),
      connected,
    );
    expect(status).toMatchObject({
      error: "gateway-suspending",
      stale: false,
      awaitingGateway: false,
    });
  });

  it("shows a stale-only warning without an alert or a button", () => {
    const container = renderStatus({ ...completePanelRefresh(), stale: true });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Showing stale data");
    expect(container.querySelector('[role="alert"], button')).toBeNull();
  });
});
