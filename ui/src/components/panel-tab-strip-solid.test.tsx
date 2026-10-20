/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { PanelTabStrip, type SolidPanelTabStripTab } from "./panel-tab-strip-solid.tsx";

function makeTab(id: string, label: string): SolidPanelTabStripTab {
  return { id, domId: `tab-${id}`, label, closeLabel: `Close ${id}` };
}
const first = makeTab("first", "First"),
  second = makeTab("second", "Second");
function mountStrip(
  initial = [first, second],
  onReorder?: Parameters<typeof PanelTabStrip>[0]["onReorder"],
) {
  const [tabs, setTabs] = createSignal(initial);
  const [activeId, setActiveId] = createSignal<string | null>(initial[0]?.id ?? null);
  const callbacks = { onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn() };
  const view = mountSolid(() => (
    <PanelTabStrip
      tabs={tabs()}
      activeId={activeId()}
      ariaControls="panel"
      {...callbacks}
      onReorder={onReorder}
      newLabel="New tab"
    />
  ));
  const query = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  const button = (id: string) => view.container.querySelector<HTMLButtonElement>(`#tab-${id}`)!;
  const update = (next: SolidPanelTabStripTab[], active = activeId()) => {
    setTabs(next);
    setActiveId(active);
    flush();
  };
  return { ...view, ...callbacks, button, query, update };
}
afterEach(() => {
  document.documentElement.removeAttribute("dir");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("preserves keyed nodes, controlled selection, and updated labels", () => {
  const { button, update, onSelect, container } = mountStrip();
  const firstNode = button("first"),
    secondNode = button("second");
  firstNode.click();
  expect(onSelect).not.toHaveBeenCalled();
  secondNode.click();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("second");
  update([{ ...second, label: "Renamed second" }, first], "second");
  expect([...container.querySelectorAll('[role="tab"]')]).toEqual([secondNode, firstNode]);
  expect(secondNode).toMatchObject({ textContent: expect.stringContaining("Renamed second") });
  expect(secondNode.getAttribute("aria-selected")).toBe("true");
  expect([button("second-close").tabIndex, button("first-close").tabIndex]).toEqual([0, -1]);
  secondNode.click();
  expect(onSelect).toHaveBeenCalledOnce();
});

it("creates the group only for populated lists and slots the new-tab action", () => {
  const { query, update, onNew } = mountStrip([]);
  expect(query(".tabstrip")).toBeNull();
  expect(query(".tabstrip-new")?.hasAttribute("slot")).toBe(false);
  query(".tabstrip-new")!.click();
  expect(onNew).toHaveBeenCalledOnce();
  update([first], first.id);
  expect(query(".tabstrip")).not.toBeNull();
  expect(query(".tabstrip-new")?.getAttribute("slot")).toBe("nav");
  update([]);
  expect(query(".tabstrip")).toBeNull();
});

it("separates activation, keyboard repeat, and middle-click close", () => {
  const onActivate = vi.fn();
  const { button, onClose, onSelect } = mountStrip([first, { ...second, onActivate }]);
  const tab = button("second");
  tab.click();
  for (const key of ["Enter", " "]) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    tab.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    tab.dispatchEvent(new KeyboardEvent("keydown", { key, repeat: true, bubbles: true }));
  }
  tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  tab.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
  expect(onActivate).toHaveBeenCalledTimes(3);
  expect(onClose).toHaveBeenCalledExactlyOnceWith(second.id);
  expect(onSelect).not.toHaveBeenCalled();
});

it("disables both close gestures without disabling selection", () => {
  const { button, update, onClose, onSelect } = mountStrip([
    first,
    { ...second, closeDisabled: true },
  ]);
  const tab = button("second"),
    close = button("second-close");
  expect(close.disabled).toBe(true);
  close.click();
  tab.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
  tab.click();
  expect(onClose).not.toHaveBeenCalled();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(second.id);
  update([first, second]);
  expect(close.disabled).toBe(false);
  close.click();
  expect(onClose).toHaveBeenCalledExactlyOnceWith(second.id);
});

it.each(["ltr", "rtl"])("uses the same %s edge for drag preview and reorder", (direction) => {
  document.documentElement.dir = direction;
  const onReorder = vi.fn();
  const { button, query } = mountStrip(undefined, onReorder);
  const source = button("first"),
    target = button("second");
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 80, 0));
  // jsdom does not resolve inherited direction through custom elements.
  target.style.direction = direction;
  const dataTransfer = createDataTransferStub();
  const drag = (element: HTMLElement, type: string) => {
    const event = new MouseEvent(type, { clientX: 110, bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    element.dispatchEvent(event);
  };
  drag(source, "dragstart");
  drag(target, "dragover");
  flush();
  const placement = direction === "rtl" ? "after" : "before";
  expect(target.classList.contains(`is-drop-${placement}`)).toBe(true);
  drag(target, "drop");
  expect(onReorder).toHaveBeenCalledExactlyOnceWith("first", "second", placement);
  expect(query(".tabstrip")?.hasAttribute("data-dragged-panel-tab")).toBe(false);
  flush();
  expect(target.classList.contains(`is-drop-${placement}`)).toBe(false);
});

it("releases measurement observers on disposal", () => {
  const disconnected = vi.fn();
  const observer = vi.fn(function () {
    return { observe() {}, unobserve() {}, disconnect: disconnected };
  });
  vi.stubGlobal("ResizeObserver", observer);
  const view = mountStrip();
  const initialObservers = observer.mock.calls.length;
  expect(initialObservers).toBeGreaterThan(0);
  view.unmount();
  expect(observer).toHaveBeenCalledTimes(initialObservers);
  expect(disconnected).toHaveBeenCalledTimes(initialObservers);
});
