import { createComponent, createSignal, flush, merge, type Component } from "solid-js";
import { expect, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { EMPTY_SESSION_MENU_DATA } from "../../../components/session-menu-actions.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  ChatPaneHeader,
  PaneHeaderView,
  type ChatPaneHeaderPresentation,
} from "./chat-pane-header.tsx";
import type { ChatSessionSharingProps } from "./chat-session-sharing.solid.tsx";
import "./chat-header-session-menu.ts";

export type ChatPaneHeaderProps = Parameters<typeof ChatPaneHeader>[0];

export function chatPaneHeaderSessionMenu(): NonNullable<ChatPaneHeaderProps["sessionMenuAction"]> {
  return {
    session: EMPTY_SESSION_MENU_DATA,
    worktreePath: null,
    onboarding: false,
    preferencesBrowserOnly: false,
    compact: false,
    bubbleModeEnabled: false,
    mainKey: "main",
    copyMarkdownAllowed: false,
    splitAllowed: false,
    settings: { chatShowThinking: false, chatShowToolCalls: false },
    sessionActions: [],
    sharing: null,
    groups: [],
    currentOwner: null,
    actionDisabledReasons: {},
    forkDisabled: false,
    forkFromLastCompleted: false,
    archiveAllowed: false,
    archiveShortcut: false,
    deleteAllowed: false,
    onOpen: vi.fn(),
    onOpenCommandPalette: vi.fn(),
    onSettingsChange: vi.fn(),
    onAction: vi.fn(),
  };
}

const mountedHeaders = new WeakMap<HTMLElement, (value: ChatPaneHeaderPresentation) => void>();

function mountUpdating<T extends object>(
  component: Component<T>,
  initial: T,
  container: HTMLElement,
) {
  const [current, setCurrent] = createSignal(initial);
  const render = () => createComponent(component, merge(current));
  const mounted = mountSolid(render, { container });
  return {
    container,
    unmount: mounted.unmount,
    get props() {
      return current();
    },
    replace(value: T) {
      setCurrent(() => value);
      flush();
    },
    update(this: void, changes: Partial<T>) {
      setCurrent(() => ({ ...current(), ...changes }));
      flush();
    },
  };
}

export function renderPaneHeaderInto(value: ChatPaneHeaderPresentation, container: HTMLElement) {
  const update = mountedHeaders.get(container);
  if (update) {
    update(value);
    return;
  }
  const mounted = mountUpdating(PaneHeaderView, value, container);
  mountedHeaders.set(container, mounted.replace);
  onTestFinished(() => {
    mountedHeaders.delete(container);
    mounted.unmount();
  });
}

export function chatPaneHeaderSharing(
  patch: Partial<ChatSessionSharingProps> = {},
): ChatSessionSharingProps {
  return {
    session: chatPaneHeaderSessionRow({ visibility: "shared", sharingRole: "owner" }),
    onOpen: vi.fn(),
    onVisibilityChange: vi.fn(),
    onMemberChange: vi.fn(),
    ...patch,
  };
}

async function settleNativeMenu() {
  flush();
  await Promise.resolve();
  flush();
}

export async function openNativeMenu(menu: Element) {
  await settleNativeMenu();
  const panel = menu.querySelector<HTMLElement>(".oc-menu")!;
  if (!panel.matches(":popover-open")) {
    menu.querySelector<HTMLButtonElement>(".oc-menu-trigger")!.click();
    await settleNativeMenu();
  }
  expect(panel.matches(":popover-open")).toBe(true);
}

export async function selectNativeMenu(menu: Element, value: string) {
  await openNativeMenu(menu);
  const item = menu.querySelector<HTMLButtonElement>(`button[data-value="${value}"]`);
  if (!item) {
    throw new Error(`Expected native menu action: ${value}`);
  }
  expect(item.disabled).toBe(false);
  item.click();
  await settleNativeMenu();
}

export function chatPaneHeaderSessionRow(
  patch: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return { key: "agent:main:test", kind: "direct", updatedAt: 0, ...patch };
}

export function mountChatPaneHeader(
  containers: HTMLElement[],
  patch: Partial<ChatPaneHeaderProps> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const props: ChatPaneHeaderProps = {
    paneId: "pane-1",
    presented: true,
    narrow: false,
    mergedChrome: false,
    title: "Session title",
    session: chatPaneHeaderSessionRow(),
    catalog: false,
    editing: false,
    renameValue: "Session title",
    workspaceRoot: "/repo/openclaw",
    workspaceLabel: "openclaw",
    workspaceIcon: null,
    parentSession: null,
    branch: "feature/header",
    branches: [],
    branchSwitchDisabledReason: null,
    platform: "darwin",
    canReveal: true,
    copiedAction: null,
    onBeginRename: vi.fn(),
    onRenameInput: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onMenuOpenChange: vi.fn(),
    onMenuAction: vi.fn(),
    onOpenParentSession: vi.fn(),
    onOpenAgentSettings: vi.fn(),
    onBranchSelect: vi.fn(),
    ...patch,
  };
  const mounted = mountUpdating(ChatPaneHeader, props, container);
  onTestFinished(mounted.unmount);
  return mounted;
}

export function mockWorkspaceIconFetch() {
  const workspaceFetch = vi.fn<typeof fetch>();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    // Other header asset requests must not consume workspace retry responses.
    if (typeof input === "string" && input.startsWith("/__openclaw__/workspace-icon/")) {
      return workspaceFetch(input, init);
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  return workspaceFetch;
}
