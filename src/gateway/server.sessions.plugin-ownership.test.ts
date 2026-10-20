import { expect, test } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { runSessionMutation } from "../sessions/session-controller.lifecycle.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const pluginOptions = (scope: "operator.write" | "operator.admin") => ({
  client: {
    connect: { scopes: [scope] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never,
});
const writeOptions = pluginOptions("operator.write");
const adminOptions = pluginOptions("operator.admin");

async function ownedSession(sessionId: string) {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dreaming-narrative-owned";
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(sessionId, { pluginOwnerId: "memory-core" }) },
  });
  return { storePath, sessionKey, sessionId };
}

test("sessions.reset prevents a plugin from resetting another plugin's session", async () => {
  const key = "agent:main:dreaming-narrative-foreign";
  const entry = sessionStoreEntry("foreign-plugin-session", { pluginOwnerId: "other-plugin" });
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { [key]: entry } });
  const reset = await directSessionReq("sessions.reset", { key }, writeOptions);

  expect(reset.ok).toBe(false);
  expect(reset.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: `Plugin "memory-core" cannot reset session "${key}" because it did not create it.`,
  });
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    sessionId: entry.sessionId,
    pluginOwnerId: "other-plugin",
  });
});

test("sessions.reset stamps plugin ownership when it materializes a missing session", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dreaming-narrative-new";
  const reset = await directSessionReq("sessions.reset", { key: sessionKey }, writeOptions);

  expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    pluginOwnerId: "memory-core",
  });

  const patched = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, label: "Reset-created plugin session" },
    writeOptions,
  );

  expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
});

test("sessions.reset rechecks plugin ownership inside lifecycle admission", async () => {
  const { storePath, sessionKey, sessionId } = await ownedSession("owned-plugin-session");
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  let replaced = false;

  const reset = await performGatewaySessionReset({
    key: sessionKey,
    reason: "reset",
    commandSource: "gateway:sessions.reset",
    workerPlacementContext: {},
    authorizedPluginId: "memory-core",
    assertCurrent: () => {
      if (replaced) {
        return;
      }
      replaced = true;
      replaceSessionEntrySync(
        { sessionKey, storePath },
        sessionStoreEntry(sessionId, { pluginOwnerId: "other-plugin" }),
      );
    },
  });

  expect(reset.ok).toBe(false);
  if (!reset.ok) {
    expect(reset.error.message).toBe(
      `Plugin "memory-core" cannot reset session "${sessionKey}" because it did not create it.`,
    );
  }
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    pluginOwnerId: "other-plugin",
    sessionId,
  });
});

test("sessions.patch limits plugin-runtime mutations to sessions owned by that plugin", async () => {
  const { storePath } = await createSessionStoreDir();
  const ownedKey = "agent:main:dreaming-narrative-owned";
  const foreignKey = "agent:main:dreaming-narrative-foreign";
  const operatorKey = "agent:main:dashboard:operator-owned";
  await writeSessionStore({
    entries: {
      [ownedKey]: sessionStoreEntry("sess-owned", { pluginOwnerId: "memory-core" }),
      [foreignKey]: sessionStoreEntry("sess-foreign", { pluginOwnerId: "other-plugin" }),
      [operatorKey]: sessionStoreEntry("sess-operator"),
    },
  });
  for (const key of [foreignKey, operatorKey]) {
    const denied = await directSessionReq(
      "sessions.patch",
      { key, label: "unauthorized mutation" },
      adminOptions,
    );

    expect(denied.ok).toBe(false);
    expect(denied.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: `Plugin "memory-core" cannot patch session "${key}" because it did not create it.`,
    });
    expect(loadSessionEntry({ sessionKey: key, storePath })?.label).toBeUndefined();
  }

  const patched = await directSessionReq(
    "sessions.patch",
    { key: ownedKey, label: "authorized mutation" },
    adminOptions,
  );

  expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
  expect(loadSessionEntry({ sessionKey: ownedKey, storePath })?.label).toBe("authorized mutation");
});

test("sessions.patch rechecks plugin ownership after waiting for lifecycle admission", async () => {
  const { storePath, sessionKey, sessionId } = await ownedSession("sess-owned");
  const releaseMutation = createDeferred();
  const { promise: mutationStarted, resolve: markMutationStarted } = createDeferred();
  const mutation = runSessionMutation({
    scope: storePath,
    identities: [sessionKey, sessionId],
    run: async () => {
      markMutationStarted();
      await releaseMutation.promise;
    },
  });
  await mutationStarted;
  const patch = directSessionReq(
    "sessions.patch",
    { key: sessionKey, label: "unauthorized raced mutation" },
    adminOptions,
  );
  await Promise.resolve();
  await replaceSessionEntry(
    { sessionKey, storePath },
    sessionStoreEntry(sessionId, { pluginOwnerId: "other-plugin" }),
  );
  releaseMutation.resolve();

  const [patched] = await Promise.all([patch, mutation]);

  expect(patched.ok).toBe(false);
  expect(patched.error?.message).toContain("did not create it");
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    pluginOwnerId: "other-plugin",
  });
  expect(loadSessionEntry({ sessionKey, storePath })?.label).toBeUndefined();
});
