/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { focusChatComposerFromPrintableKeydown } from "../chat-pane-shared.ts";
import { ChatPermissionPicker, type ChatPermissionPickerProps } from "./chat-permission-picker.tsx";

function key(target: EventTarget, value: string) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
  );
}

const option = (container: HTMLElement, mode: string) =>
  container.querySelector<HTMLElement>(`[data-chat-permission-option="${mode}"]`);
const menuOpen = (menu: HTMLElement) =>
  waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));

function picker(options: ChatPermissionPickerProps) {
  const [props, setProps] = createSignal(options);
  const { container } = mountSolid(() => <ChatPermissionPicker {...props()} />);
  flush();
  return {
    container,
    trigger: container.querySelector<HTMLButtonElement>("[data-chat-permission-select]")!,
    menu: container.querySelector<HTMLElement>('[role="menu"]')!,
    update(changes: Partial<ChatPermissionPickerProps>) {
      setProps({ ...props(), ...changes });
      flush();
    },
  };
}

it("keeps locked modes unavailable, routes shortcuts, and returns ordinary typing to the composer", async () => {
  const onSelect = vi.fn();
  const canSelectFull = vi.fn(() => false);
  const { container, trigger, menu } = picker({
    get canSelectFull() {
      return canSelectFull();
    },
    mode: "guarded",
    onSelect,
  });
  expect(canSelectFull).not.toHaveBeenCalled();
  container.insertAdjacentHTML(
    "afterbegin",
    '<div class="agent-chat__composer-combobox"><textarea></textarea></div>',
  );
  const composer = container.querySelector("textarea")!;
  const redirect = (event: KeyboardEvent) =>
    focusChatComposerFromPrintableKeydown(container, event, composer);
  composer.focus();
  trigger.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
  await menuOpen(menu);
  expect(document.activeElement).toBe(trigger);
  expect(option(container, "full")?.matches(":disabled")).toBe(true);
  key(menu, "5");
  expect(onSelect).not.toHaveBeenCalled();
  expect(menu.matches(":popover-open")).toBe(true);
  key(menu, "4");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("workspace");
  expect(document.activeElement).toBe(trigger);
  document.addEventListener("keydown", redirect, true);
  onTestFinished(() => document.removeEventListener("keydown", redirect, true));
  trigger.click();
  await menuOpen(menu);
  key(trigger, "4");
  expect(onSelect.mock.calls).toEqual([["workspace"], ["workspace"]]);
  expect(document.activeElement).toBe(trigger);
  trigger.click();
  await menuOpen(menu);
  key(document.activeElement!, "q");
  expect(document.activeElement).toBe(composer);
  expect(onSelect).toHaveBeenCalledTimes(2);
});

it("includes the documentation link in keyboard menu navigation", async () => {
  const { container, trigger } = picker({ canSelectFull: false, onSelect: vi.fn() });
  trigger.focus();
  key(trigger, "ArrowDown");
  await waitForSolid(() =>
    expect(container.querySelector(".chat-controls__permission-learn-more")).not.toBeNull(),
  );
  const link = container.querySelector<HTMLAnchorElement>(".chat-controls__permission-learn-more")!;
  await waitForSolid(() => expect(document.activeElement).toBe(link));
  expect(link.getAttribute("href")).toBe("https://docs.openclaw.ai/gateway/permission-modes");
  expect(link.target).toBe("_blank");
  key(link, "ArrowDown");
  await waitForSolid(() => expect(document.activeElement).toBe(option(container, "default")));
  key(document.activeElement!, "Home");
  await waitForSolid(() => expect(document.activeElement).toBe(link));
});

it("preserves option content on unrelated refreshes while admitting permission changes", async () => {
  const { container, trigger, update } = picker({ canSelectFull: false, onSelect: vi.fn() });
  trigger.click();
  await waitForSolid(() =>
    expect(container.querySelector('[role="menu"]')?.matches(":popover-open")).toBe(true),
  );
  const row = option(container, "default")!;
  const content = row.querySelector(".chat-controls__permission-option-copy");
  const icon = row.querySelector(".chat-controls__permission-option-icon");
  const observer = new MutationObserver(() => {});
  observer.observe(container, { childList: true, subtree: true });
  onTestFinished(() => observer.disconnect());

  update({ disabledReason: "Unrelated connection notice" });
  expect(observer.takeRecords()).toHaveLength(0);
  expect(row.querySelector(".chat-controls__permission-option-copy")).toBe(content);
  expect(row.querySelector(".chat-controls__permission-option-icon")).toBe(icon);

  update({ defaultMode: "guarded", mode: "workspace", canSelectFull: true });
  expect(option(container, "default")).toBe(row);
  expect(row.textContent).toContain("Default (Guarded)");
  expect(option(container, "workspace")?.getAttribute("aria-checked")).toBe("true");
  expect(option(container, "full")?.matches(":disabled")).toBe(false);
});
