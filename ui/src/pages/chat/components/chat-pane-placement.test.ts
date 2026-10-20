/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatPanePlacement } from "./chat-pane-placement.tsx";

type Props = Parameters<typeof ChatPanePlacement>[0];
const timestamps = {
  generation: 2,
  createdAtMs: 100_000,
  updatedAtMs: 300_000,
  stateChangedAtMs: 300_000,
};
const activePlacement = {
  ...timestamps,
  state: "active",
  environmentId: "worker:device",
  activeOwnerEpoch: 1,
  workerBundleHash: "a".repeat(64),
  workspaceBaseManifestRef: "base-manifest",
  remoteWorkspaceDir: "/worker/repo",
} satisfies GatewaySessionRow["placement"];

function mount(session: Partial<GatewaySessionRow>, props: Omit<Props, "session"> = {}) {
  return mountSolid(() =>
    createComponent(ChatPanePlacement, {
      session: { key: "agent:main:test", kind: "direct", updatedAt: 0, ...session },
      ...props,
    }),
  ).container;
}

const text = (container: HTMLElement, part: string) =>
  container.querySelector(`.chat-pane__placement-${part}`)?.textContent?.trim();

async function openPlacement(container: HTMLElement) {
  const panel = container.querySelector<HTMLElement>('.chat-pane__placement-menu > [role="menu"]')!;
  expect(panel.querySelector("[role^=menuitem]")).toBeNull();
  container.querySelector<HTMLButtonElement>(".chat-pane__placement-chip")!.click();
  await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(true));
}

describe("chat pane device placement", () => {
  it.each(["profile", "device"] as const)(
    "presents post-turn workspace sync for %s without cloud-only wording",
    async (target) => {
      const container = mount({
        agentRuntime: { id: "openclaw", source: "model" as const },
        placement: {
          ...activePlacement,
          workspaceResultReconciling: true,
          ...(target === "device"
            ? {
                providerId: "device",
                profileId: "native",
                inference: "worker" as const,
                runner: {
                  kind: "device" as const,
                  deviceId: "paired",
                  status: "available" as const,
                },
              }
            : {}),
          environmentId: "worker:cloud",
        },
      });
      expect(text(container, "chip")).toBe("Worker · syncing files");
      await openPlacement(container);
      expect(text(container, "note")).toContain("Finalizing worker workspace");
      expect(container.querySelector("openclaw-elapsed-time")).toBeNull();
      if (target === "device") {
        expect(container.textContent).toContain("Inference");
        expect(container.textContent).toContain("Direct from worker");
      } else {
        expect(container.textContent).not.toContain("Inference");
        expect(container.textContent).not.toContain("Through Gateway");
      }
    },
  );

  it.each([
    {
      phase: "starting" as const,
      status: "available" as const,
      targetKind: "profile" as const,
      stop: "Stop device worker…",
      label: "Runs on device",
      move: "Move session…",
      waiting: false,
    },
    {
      phase: "failed" as const,
      status: "offline" as const,
      targetKind: "profile" as const,
      stop: "Stop device worker…",
      label: "Device offline",
      move: "Continue on Gateway…",
      waiting: true,
    },
    {
      phase: "failed" as const,
      status: undefined,
      targetKind: "device" as const,
      label: "Runs on Cloud",
      move: "Move session…",
      waiting: false,
      stop: "Stop cloud worker…",
    },
  ])(
    "renders $status active ownership ahead of $phase $targetKind startup intent",
    async (scenario) => {
      const container = mount(
        {
          placement: {
            ...activePlacement,
            runner: scenario.status ? { kind: "device", status: scenario.status } : undefined,
          },
        },
        {
          placementStartupStatus: { phase: scenario.phase, targetKind: scenario.targetKind },
          placementReclaimDisabledReason:
            scenario.status === "offline"
              ? "Reconnect the device to stop and sync its workspace, or Continue on Gateway."
              : undefined,
        },
      );
      expect(text(container, "chip")).toBe(scenario.label);
      await openPlacement(container);
      expect(text(container, "move")).toBe(scenario.move);
      const note = container.querySelector(".chat-pane__placement-note");
      const move = container.querySelector<HTMLElement>(".chat-pane__placement-move");
      const reclaim = container.querySelector<HTMLElement>(".chat-pane__placement-reclaim");
      expect(move?.hasAttribute("disabled")).toBe(false);
      expect(reclaim?.textContent?.trim()).toBe(scenario.stop);
      if (scenario.waiting) {
        expect(note?.textContent).toContain("Waiting for device to reconnect");
        expect(reclaim?.hasAttribute("disabled")).toBe(true);
        expect(reclaim?.title).toContain("Reconnect the device");
      } else {
        expect(note).toBeNull();
        expect(reclaim?.hasAttribute("disabled")).toBe(false);
      }
    },
  );

  it.each(["local", undefined] as const)(
    "offers worker dispatch for a repository-only session with %s placement",
    async (placementState) => {
      const onPlacementRecover = vi.fn();
      const container = mount(
        {
          repositoryWorkspaceId: "repository-workspace-1",
          ...(placementState
            ? {
                placement: {
                  state: placementState,
                  generation: 1,
                  createdAtMs: 1,
                  updatedAtMs: 1,
                  stateChangedAtMs: 1,
                },
              }
            : {}),
        },
        { onPlacementRecover },
      );
      expect(text(container, "chip")).toBe("Worker required");
      await openPlacement(container);
      const dispatch = container.querySelector<HTMLButtonElement>(".chat-pane__placement-recovery");
      expect(container.querySelectorAll(".chat-pane__placement-recovery")).toHaveLength(1);
      expect(dispatch?.textContent?.trim()).toBe("Choose worker…");
      expect(container.querySelector(".chat-pane__placement-move")).toBeNull();
      dispatch?.click();
      await waitForSolid(() => expect(onPlacementRecover).toHaveBeenCalledOnce());
    },
  );

  it("offers restart without a redundant stop action after a failed worker is gone", async () => {
    const container = mount({
      placement: {
        ...timestamps,
        state: "failed",
        recoveryError: "worker disappeared",
        recoveryAction: "restart",
      },
    });
    await openPlacement(container);
    expect(text(container, "recovery")).toBe("Restart session…");
    expect(container.querySelector(".chat-pane__placement-reclaim")).toBeNull();
  });

  it("requires stop before restart while the failed worker environment may remain", async () => {
    const container = mount({
      placement: {
        ...timestamps,
        state: "failed",
        recoveryError: "worker disappeared",
        recoveryAction: "stop-first",
      },
    });
    await openPlacement(container);
    expect(container.querySelector(".chat-pane__placement-recovery")).toBeNull();
    expect(text(container, "reclaim")).toBe("Stop worker…");
  });
});
