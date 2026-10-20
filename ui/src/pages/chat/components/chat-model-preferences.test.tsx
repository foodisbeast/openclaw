/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { createSessionsListResult } from "../../../test-helpers/chat-model.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatModelControls } from "./chat-model-controls.tsx";

type Props = Parameters<typeof ChatModelControls>[0];

async function controls(overrides: Partial<Props>) {
  const sessions = createSessionsListResult({ model: "primary", modelProvider: "example" });
  const selectedSession = {
    ...sessions.sessions[0]!,
    thinkingLevel: "high",
    thinkingLevels: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
  };
  const onModelSelect = vi.fn(async () => true);
  const onThinkingSelect = vi.fn(async () => true);
  const onFastModeSelect = vi.fn(async () => true);
  const props: Props = {
    activeRunId: null,
    connected: true,
    gatewayAvailable: true,
    loading: false,
    modelSwitching: false,
    modelPickerOpen: true,
    modelCatalogState: { hasSnapshot: true, status: "ready" },
    sending: false,
    stream: null,
    sessionKey: "main",
    modelCatalog: ["primary", "other"].map((id) => ({
      id,
      name: id,
      provider: "example",
      supportsFastMode: true,
    })),
    selectedSession,
    thinkingSession: selectedSession,
    sessionsResult: sessions,
    onModelSelect,
    onThinkingSelect,
    onFastModeSelect,
    ...overrides,
  };
  const [current, setCurrent] = createSignal(props);
  const { container } = mountSolid(() => <ChatModelControls {...current()} />);
  const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__effort-picker")!;
  picker.open = true;
  picker.dispatchEvent(new Event("toggle"));
  flush();
  await waitForSolid(() =>
    expect(container.querySelector(".chat-controls__model-menu")).not.toBeNull(),
  );
  const update = (next: Partial<Props>) => {
    setCurrent({ ...current(), ...next });
    flush();
  };
  const control = <T extends HTMLElement>(name: string) =>
    expectDefined(container.querySelector<T>(`[data-chat-${name}]`), name);
  return {
    container,
    update,
    onModelSelect,
    onThinkingSelect,
    onFastModeSelect,
    model: control("model-select"),
    option: control<HTMLButtonElement>('model-option="example/other"'),
    effort: control("thinking-select"),
    slider: control<HTMLInputElement>("thinking-slider"),
    speed: control<HTMLButtonElement>("speed-option=on"),
  };
}

it.each([
  { name: "sending", sending: true },
  { name: "preparing", activeRunId: "active-run" },
  { name: "streaming", stream: "A reply in progress" },
])("edits model, reasoning, and speed preferences while $name", async (busy) => {
  const view = await controls(busy);
  const { model, option, effort, slider, speed } = view;
  expect(model.getAttribute("aria-disabled")).toBe("false");
  expect(effort.getAttribute("aria-disabled")).toBe("false");
  option.click();
  expect(view.onModelSelect).toHaveBeenCalledWith("example/other", "main", undefined);
  expect(slider.disabled).toBe(false);
  slider.value = "0";
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(view.onThinkingSelect).toHaveBeenCalledWith("low", "main");
  expect(speed.disabled).toBe(false);
  speed.click();
  expect(view.onFastModeSelect).toHaveBeenCalledWith("on", "main");
});

it.each([
  { name: "offline", connected: false },
  { name: "missing backend", gatewayAvailable: false },
  { name: "model switch", modelSwitching: true },
  {
    name: "write denied",
    modelMutationDisabledReason: "Read only",
    effortMutationDisabledReason: "Read only",
  },
])("retains $name guards during an active response", async (guard) => {
  const { model, option, slider, onModelSelect, onThinkingSelect } = await controls({
    ...guard,
    activeRunId: "active-run",
    stream: "Working",
  });
  expect(model.getAttribute("aria-disabled")).toBe("true");
  expect(slider.disabled).toBe(true);
  option.click();
  slider.value = "0";
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onModelSelect).not.toHaveBeenCalled();
  expect(onThinkingSelect).not.toHaveBeenCalled();
});

it("retires and restores an unavailable context-window control with its access guard", async () => {
  const contextWindowTarget = {
    contextWindow: "standard",
    contextWindowDefault: "standard",
    contextWindows: [
      { id: "standard", label: "Standard", contextWindow: 100_000 },
      { id: "extended", label: "Extended", contextWindow: 200_000 },
    ],
  };
  const view = await controls({
    contextWindowTarget,
    contextWindowMutationDisabledReason: "Admin only",
  });
  const toggle = () =>
    view.container.querySelector<HTMLButtonElement>("[data-chat-context-window-toggle]");
  expect(toggle()?.disabled).toBe(true);
  view.update({ contextWindowTarget: { contextWindows: [] } });
  expect(toggle()).toBeNull();
  view.update({ contextWindowTarget });
  expect(toggle()?.disabled).toBe(true);
});
