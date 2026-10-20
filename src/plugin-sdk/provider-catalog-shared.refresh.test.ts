import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureProviderCatalogExpiries,
  withProviderCatalogExpiry,
  withProviderCatalogDiscoveryBudget,
} from "../plugins/provider-catalog-expiry.js";
import {
  clearLiveCatalogCacheForTests,
  getCachedLiveCatalogValue,
} from "./provider-catalog-shared.js";

const withFixtureExpiry = <T>(read: () => Promise<T>) =>
  withProviderCatalogExpiry(read, () => ["fixture"]);
const refreshTwice = (read: () => Promise<string>) =>
  captureProviderCatalogExpiries(async () => [await read(), await read()], { refresh: true });
const readCatalog = <T>(params: Parameters<typeof getCachedLiveCatalogValue<T>>[0]) =>
  withFixtureExpiry(() => getCachedLiveCatalogValue(params));

beforeEach(() => clearLiveCatalogCacheForTests());

it("refreshes only requested keys once per acquisition and retains the refreshed TTL", async () => {
  let now = 1_000;
  let advertised = "original";
  const load = vi.fn(async () => advertised);
  const read = (credential = "synthetic-account-a", endpoint = "https://catalog.example/a") =>
    readCatalog({
      keyParts: ["fixture", endpoint, credential],
      ttlMs: 3_600_000,
      now: () => now,
      load,
    });

  const initial = await captureProviderCatalogExpiries(() => read());
  await read("synthetic-account-b");
  await read("synthetic-account-a", "https://catalog.example/b");
  expect(load).toHaveBeenCalledTimes(3);
  expect(initial.providerExpiries.get("fixture")).toBe(3_601_000);

  advertised = "newly-granted";
  now = 2_000;
  expect((await captureProviderCatalogExpiries(() => read())).value).toBe("original");
  const refreshed = await refreshTwice(read);
  expect(refreshed.value).toEqual(["newly-granted", "newly-granted"]);
  expect(refreshed.providerExpiries.get("fixture")).toBe(3_602_000);
  expect(load).toHaveBeenCalledTimes(4);

  now = 3_000;
  const ordinary = await captureProviderCatalogExpiries(() => read());
  expect(ordinary.value).toBe("newly-granted");
  expect(ordinary.providerExpiries.get("fixture")).toBe(3_602_000);
  await expect(read("synthetic-account-b")).resolves.toBe("original");
  await expect(read("synthetic-account-a", "https://catalog.example/b")).resolves.toBe("original");
  expect(load).toHaveBeenCalledTimes(4);

  advertised = "second-grant";
  expect((await captureProviderCatalogExpiries(() => read(), { refresh: true })).value).toBe(
    "second-grant",
  );
  expect(load).toHaveBeenCalledTimes(5);
});

it("shares a pending refresh with concurrent acquisitions and ordinary consumers", async () => {
  const completion = createDeferred<string>();
  const load = vi.fn<() => Promise<string>>().mockResolvedValueOnce("original");
  const read = () => readCatalog({ keyParts: ["shared-refresh"], load });
  await captureProviderCatalogExpiries(read);
  load.mockImplementation(() => completion.promise);

  const first = refreshTwice(read);
  const second = refreshTwice(read);
  const ordinary = captureProviderCatalogExpiries(read);
  try {
    expect(load).toHaveBeenCalledTimes(2);
    completion.resolve("fresh");
    expect([(await first).value, (await second).value]).toEqual([
      ["fresh", "fresh"],
      ["fresh", "fresh"],
    ]);
    expect((await ordinary).value).toBe("fresh");
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    completion.resolve("fresh");
    await Promise.allSettled([first, second, ordinary]);
  }
});

it("surfaces a failed explicit acquisition instead of restoring a bypassed warm value", async () => {
  const failure = new Error("catalog request timed out");
  const load = vi
    .fn<() => Promise<string>>()
    .mockResolvedValueOnce("original")
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce("recovered");
  const read = () => readCatalog({ keyParts: ["failed-refresh"], load });
  expect((await captureProviderCatalogExpiries(read)).value).toBe("original");
  await expect(captureProviderCatalogExpiries(read, { refresh: true })).rejects.toBe(failure);
  expect((await captureProviderCatalogExpiries(read)).value).toBe("recovered");
  expect(load).toHaveBeenCalledTimes(3);
});

it.each([
  [5_000, 180_000],
  [180_000, 5_000],
])(
  "isolates %ims and %ims pending loads without fragmenting healthy results",
  async (firstBudget, secondBudget) => {
    const firstLoad = createDeferred<string>();
    const secondLoad = createDeferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(() => secondLoad.promise);
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const read = (budget: number, refresh = true) =>
      withProviderCatalogDiscoveryBudget(budget, () =>
        captureProviderCatalogExpiries(() => readCatalog({ keyParts: ["budget-order"], load }), {
          refresh,
        }),
      );
    try {
      const first = read(firstBudget);
      now.mockReturnValue(100);
      const second = read(secondBudget);
      now.mockReturnValue(200);
      const sameBudgetSibling = read(firstBudget);
      expect(load).toHaveBeenCalledTimes(2);

      secondLoad.resolve("newer");
      expect((await second).value).toBe("newer");
      firstLoad.resolve("older");
      const [original, sibling] = await Promise.all([first, sameBudgetSibling]);
      expect([original.value, sibling.value]).toEqual(["older", "older"]);
      expect(original.providerExpiries.get("fixture")).toBeGreaterThan(Date.now());
      // Older completion returns to its observers but cannot replace the newer cache generation.
      expect((await read(firstBudget, false)).value).toBe("newer");
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      firstLoad.resolve("older");
      secondLoad.resolve("newer");
      now.mockRestore();
    }
  },
);

it("retries an unsuccessful short acquisition with the explicit budget", async () => {
  const load = vi
    .fn<() => Promise<string[]>>()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(["healthy"]);
  const read = (budget: number) =>
    withProviderCatalogDiscoveryBudget(budget, () =>
      getCachedLiveCatalogValue({
        keyParts: ["failed-short"],
        load,
        shouldCache: (rows) => rows.length > 0,
      }),
    );
  expect(await read(5_000)).toEqual([]);
  expect(await read(180_000)).toEqual(["healthy"]);
  expect(await read(5_000)).toEqual(["healthy"]);
  expect(load).toHaveBeenCalledTimes(2);
});

it("publishes cached-result freshness through the nested acquisition budget", async () => {
  const result = await captureProviderCatalogExpiries(() =>
    withFixtureExpiry(() =>
      withProviderCatalogDiscoveryBudget(180_000, () =>
        getCachedLiveCatalogValue({
          keyParts: ["budget-expiry"],
          load: async () => "healthy",
          ttlMs: 1_000,
          now: () => 100,
        }),
      ),
    ),
  );
  expect(result.value).toBe("healthy");
  expect(result.providerExpiries.get("fixture")).toBe(1_100);
});
