import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import type { ChannelReplayGuard } from "./channel-replay-guard.js";
import { createChannelReplayGuard } from "./persistent-dedupe.js";

type ReplayEvent = {
  accountId: string;
  keys: readonly (string | null | undefined)[];
};

function createGuard() {
  const guard = createChannelReplayGuard<ReplayEvent>({
    dedupe: { ttlMs: 10_000, memoryMaxSize: 100 },
    buildReplayKey: (event) => event.keys,
    namespace: (event) => event.accountId,
  });
  const claimKeys = (...keys: string[]) => guard.claim({ accountId: "work", keys });
  return Object.assign(guard, {
    claimKeys,
    own: async (...keys: string[]) => expectClaimed(await claimKeys(...keys)),
  });
}

async function expectClaimed(claim: Awaited<ReturnType<ChannelReplayGuard<ReplayEvent>["claim"]>>) {
  assert(claim.kind === "claimed", `expected claimed result, received ${claim.kind}`);
  return claim.handle;
}

it("fails open for invalid keys without recording them", async () => {
  const guard = createGuard();
  const event = { accountId: "work", keys: [" ", null, undefined] };
  const process = vi.fn(async () => "handled");

  await expect(guard.claim(event)).resolves.toEqual({ kind: "invalid" });
  await expect(guard.shouldProcess(event)).resolves.toBe(true);
  await expect(guard.processGuarded(event, process)).resolves.toEqual({
    kind: "processed",
    value: "handled",
  });
  expect("commit" in guard).toBe(false);
  expect("release" in guard).toBe(false);
  expect(process).toHaveBeenCalledOnce();
});

it.each(["first", "second"] as const)("settles only owned keys when %s fails", async (failed) => {
  const guard = createGuard();
  const first = await guard.own("shared", "first-only");
  const second = await guard.own("shared", "second-only");
  expect(second.keys).toEqual(["second-only"]);
  const sharedWaiter = await guard.claimKeys("shared");
  const secondWaiter = await guard.claimKeys("second-only");
  const error = new Error(`${failed} handler failed`);
  if (failed === "first") {
    await expect(second.commit()).resolves.toBe(true);
    first.release({ error });
  } else {
    second.release({ error });
    await expect(first.commit()).resolves.toBe(true);
  }
  for (const [waiter, rejected] of [
    [sharedWaiter, failed === "first"],
    [secondWaiter, failed === "second"],
  ] as const) {
    assert(waiter.kind === "inflight", "Expected in-flight claim");
    if (rejected) {
      await expect(waiter.pending).rejects.toBe(error);
    } else {
      await expect(waiter.pending).resolves.toBe(true);
    }
  }
  const kinds = failed === "first" ? ["claimed", "duplicate"] : ["duplicate", "claimed"];
  const sharedKeys = failed === "first" ? ["shared"] : ["shared", "first-only"];
  for (const [index, keys] of [sharedKeys, ["second-only"]].entries()) {
    const result = await guard.claimKeys(...keys);
    if (kinds[index] === "duplicate") {
      expect(result).toEqual({ kind: "duplicate" });
    } else {
      expect(result).toMatchObject({ kind: "claimed" });
    }
  }
});

it.each([
  { errorMode: "release" as const, nextKind: "claimed" },
  { errorMode: "commit" as const, nextKind: "duplicate" },
])("uses $errorMode error settlement in processGuarded", async ({ errorMode, nextKind }) => {
  const guard = createGuard();
  const event = { accountId: "work", keys: [`message-${errorMode}`] };

  await expect(
    guard.processGuarded(
      event,
      async () => {
        throw new Error("handler failed");
      },
      { onError: errorMode },
    ),
  ).rejects.toThrow("handler failed");
  await expect(guard.claim(event)).resolves.toMatchObject({ kind: nextKind });
});

it("scopes keys by namespace and supports recency cleanup", async () => {
  const guard = createGuard();
  const work = { accountId: "work", keys: ["message-4"] };
  const home = { accountId: "home", keys: ["message-4"] };

  await expect(guard.shouldProcess(work)).resolves.toBe(true);
  await expect(guard.shouldProcess(work)).resolves.toBe(false);
  await expect(guard.shouldProcess(home)).resolves.toBe(true);
  await expect(guard.hasRecent(work)).resolves.toBe(true);
  await expect(guard.forget(work)).resolves.toBe(true);
  await expect(guard.hasRecent(work)).resolves.toBe(false);
});
