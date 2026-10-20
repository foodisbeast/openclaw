/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { i18n } from "../i18n/index.ts";
import { de } from "../i18n/locales/de.ts";
import type { NativeLinkMenu } from "./native-link-menu.runtime.ts";
import "./native-link-menu.runtime.ts";
import { settleTooltip, tooltipSurface } from "./tooltip.test-support.ts";

const containers: HTMLElement[] = [];
function append<K extends keyof HTMLElementTagNameMap>(tag: K) {
  const element = document.createElement(tag);
  document.body.append(element);
  containers.push(element);
  return element;
}
function keydown(target: EventTarget, key: string, code?: string) {
  const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}
function recordActions() {
  const calls: string[] = [];
  return {
    calls,
    onClose: () => calls.push("close"),
    onAction: (action: string) => calls.push(action),
  };
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
  await i18n.setLocale("en");
});

async function mountMenu(options: {
  trigger?: HTMLAnchorElement;
  onAction?: NativeLinkMenu["onAction"];
  onClose?: () => void;
}): Promise<NativeLinkMenu> {
  const container = append("div");
  const menu = document.createElement("openclaw-native-link-menu");
  menu.x = 100;
  menu.y = 100;
  menu.trigger = options.trigger ?? null;
  menu.onAction = options.onAction ?? (() => {});
  menu.onClose = options.onClose ?? (() => {});
  container.append(menu);
  await menu.updateComplete;
  return menu;
}

function menuItems(menu: ParentNode): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}
const labels = (menu: ParentNode) =>
  menuItems(menu).map((item) => item.querySelector(".session-menu__text")?.textContent?.trim());
function appendTrigger() {
  const trigger = append("a");
  trigger.href = "https://example.com";
  return trigger;
}

describe("native link menu", () => {
  it("renders the native link actions in order and closes before dispatch", async () => {
    const actions = recordActions();
    const menu = await mountMenu(actions);
    const items = menuItems(menu);

    await Promise.resolve();
    expect(document.activeElement).toBe(items[0]);

    expect(labels(menu)).toEqual(["Open in Browser Panel", "Open in Default Browser", "Copy Link"]);

    items[0]?.click();
    await Promise.resolve();
    expect(actions.calls).toEqual(["close", "inline"]);
  });

  it("rerenders open actions when the locale changes", async () => {
    const menu = await mountMenu({});
    const surface = menu.querySelector('[role="menu"]');
    expect(surface).not.toBeNull();
    const englishLabel = surface?.getAttribute("aria-label");

    await i18n.setLocale("de");
    await menu.updateComplete;

    const german = flattenTranslations(de);
    expect(surface?.getAttribute("aria-label")).not.toBe(englishLabel);
    await vi.waitFor(() =>
      expect(surface?.getAttribute("aria-label")).toBe(german.get("nativeLinkMenu.label")),
    );
    expect(labels(menu)).toEqual([
      // Changed English copy falls back until the post-merge locale refresh.
      german.get("nativeLinkMenu.openInline") ?? "Open in Browser Panel",
      german.get("nativeLinkMenu.openExternal"),
      german.get("nativeLinkMenu.copy"),
    ]);
  });

  it.each([
    { key: "s", code: "KeyS", action: "inline" },
    { key: "b", code: "KeyB", action: "external" },
    { key: "с", code: "KeyC", action: "copy" },
  ])("dispatches $action from its bare letter shortcut", async ({ key, code, action }) => {
    const actions = recordActions();
    const menu = await mountMenu(actions);

    const hints = menuItems(menu).map(
      (item) => item.querySelector(".session-menu__shortcut")?.textContent,
    );
    expect(hints).toEqual(["S", "B", "C"]);

    keydown(menuItems(menu)[0]!, key, code);
    await Promise.resolve();
    expect(actions.calls).toEqual(["close", action]);
  });

  it("dismisses a tooltip before its menu and restores focus", async () => {
    const trigger = appendTrigger();
    const onClose = vi.fn();
    const menu = await mountMenu({ trigger, onClose });
    const tooltip = document.createElement("openclaw-tooltip");
    tooltip.content = "Link action details";
    tooltip.anchor = menuItems(menu)[0]!;
    menu.append(tooltip);
    await tooltip.updateComplete;
    tooltip.anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    await settleTooltip(tooltip);
    const popup = tooltipSurface(tooltip)!;
    expect(popup.matches(":popover-open")).toBe(true);

    const firstEscape = keydown(menuItems(menu)[0]!, "Escape");

    expect(popup.matches(":popover-open")).toBe(false);
    expect(firstEscape.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(trigger);

    const secondEscape = keydown(menuItems(menu)[0]!, "Escape");

    expect(secondEscape.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to its durable trigger before a Tab leaves the menu", async () => {
    const trigger = appendTrigger();
    const menu = await mountMenu({ trigger });
    const item = menuItems(menu)[0];
    item?.focus();

    const event = keydown(item!, "Tab");

    expect(document.activeElement).toBe(trigger);
    expect(event.defaultPrevented).toBe(false);
  });

  it("closes after focus moves outside without stealing focus", async () => {
    const trigger = appendTrigger();
    const onClose = vi.fn();
    await mountMenu({ trigger, onClose });
    const outside = append("button");

    outside.focus();
    await Promise.resolve();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(outside);
  });
});
