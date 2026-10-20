/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatPaneHeaderSessionRow as row,
  mountChatPaneHeader,
} from "./chat-pane-header.test-support.ts";

const containers: HTMLElement[] = [];

afterEach(() => containers.splice(0).forEach((container) => container.remove()));

const owner = {
  actor: {
    type: "human",
    id: "ada",
    identity: { type: "profile", id: "ada" },
    label: "Ada King",
  },
} satisfies NonNullable<ReturnType<typeof row>["owner"]>;
const participant = (id: string, label: string) => ({
  identity: { type: "profile" as const, id },
  label,
});

describe("chat pane header identity links", () => {
  it("links the owner chip and each participant face to their activity feed", async () => {
    const navigate = vi.fn();
    const { container } = mountChatPaneHeader(containers, {
      showOwnerChip: true,
      personActivity: { basePath: "", navigate },
      session: row({
        owner,
        participants: [participant("mira", "Mira"), participant("riley", "Riley")],
        participantCount: 2,
      }),
    });

    const facepile = container.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      "openclaw-viewer-facepile.chat-pane__participants",
    );
    await facepile?.updateComplete;
    const ownerLink = container.querySelector<HTMLAnchorElement>(
      "a.person-activity-avatar-link:has(openclaw-session-owner-chip)",
    );
    expect(ownerLink?.getAttribute("href")).toBe("/activity/ada");
    const participantLinks = [
      ...container.querySelectorAll<HTMLAnchorElement>(
        ".chat-pane__participants a.person-activity-avatar-link",
      ),
    ];
    expect(participantLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/activity/mira",
      "/activity/riley",
    ]);

    ownerLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith("ada", "Ada King");
  });

  it("retains the rename control and focus while header facts and callbacks update", () => {
    const previousRename = vi.fn();
    const currentRename = vi.fn();
    const { container, update } = mountChatPaneHeader(containers, {
      onBeginRename: previousRename,
    });
    const button = container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button")!;
    const title = button.querySelector(".chat-pane__session-title-text");
    button.focus();
    update({ title: "Current session", onBeginRename: currentRename, ownerViewing: true });
    expect(container.querySelector(".chat-pane__session-title-button")).toBe(button);
    expect(button.querySelector(".chat-pane__session-title-text")).toBe(title);
    expect(button.textContent).toBe("Current session");
    expect(document.activeElement).toBe(button);
    button.click();
    expect(currentRename).toHaveBeenCalledOnce();
    expect(previousRename).not.toHaveBeenCalled();
  });

  it("leaves identities unlinked when the header has no activity routing", () => {
    const { container } = mountChatPaneHeader(containers, {
      showOwnerChip: true,
      session: row({
        owner,
        participants: [participant("mira", "Mira")],
        participantCount: 1,
      }),
    });

    expect(container.querySelector("a.person-activity-avatar-link")).toBeNull();
    expect(container.querySelector("openclaw-session-owner-chip")).not.toBeNull();
  });
});
