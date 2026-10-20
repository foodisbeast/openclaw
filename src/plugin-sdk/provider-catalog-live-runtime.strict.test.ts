import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { createDeferredCore } from "../shared/deferred.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  buildLiveModelProviderConfig as buildLive,
  buildOpenAICompatibleProviderCatalog as buildCatalog,
  buildOpenAICompatibleProviderFamilyCatalog as buildFamily,
  clearLiveCatalogCacheForTests,
  getCachedLiveProviderModelRows as readModels,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import { getCachedLiveCatalogValue } from "./provider-catalog-shared.js";
import {
  buildCatalogModel,
  catalogFixture,
  catalogResponse as jsonCatalogResponse,
} from "./provider-catalog.test-support.js";

const { fetchGuard } = vi.hoisted(() => ({ fetchGuard: vi.fn<LiveModelCatalogFetchGuard>() }));
vi.mock("./ssrf-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ssrf-runtime.js")>()),
  fetchWithSsrFGuard: fetchGuard,
}));

const catalogParams = {
  ...catalogFixture("demo", "https://catalog.example/v1", [
    buildCatalogModel("known", { name: "Known" }),
  ]),
  apiKey: "synthetic-key",
  fetchGuard,
};
const seed = catalogParams.providerConfig;
const projectRows = (rows: readonly unknown[], fallback: ModelProviderConfig) =>
  rows.length ? fallback.models : [];
const catalogResponse = (
  data: unknown,
  release: () => Promise<void>,
  finalUrl = catalogParams.endpoint,
) => jsonCatalogResponse(data, release, finalUrl);
const catalogContext = (signal?: AbortSignal) => ({
  config: {},
  env: {},
  signal,
  resolveProviderApiKey: () => ({ apiKey: "fixture-key" }),
  resolveProviderAuth: () => {
    throw new Error("Do not reselect auth");
  },
});
const familyOptions = {
  discoveryMode: "strict" as const,
  credentialProviderId: "family",
  staticCatalog: async () => ({ providers: {} }),
  augmentModelCatalog: () => [],
};
function holdCatalog(data: unknown) {
  const started = createDeferredCore();
  const ready = createDeferredCore();
  const released = createDeferredCore();
  const release = vi.fn(async () => released.resolve());
  fetchGuard.mockImplementation(async ({ url }) => {
    started.resolve();
    await ready.promise;
    return catalogResponse(data, release, url);
  });
  return { started: started.promise, finish: ready.resolve, released: released.promise, release };
}
const familyEntry = (id: string, baseUrl = seed.baseUrl, label = id) => ({
  id,
  label,
  baseUrl,
  models: seed.models,
  buildProvider: () => ({ ...seed, baseUrl }),
});
const expectModels = async (result: Promise<ModelProviderConfig>, models = seed.models) =>
  expect(await result).toMatchObject({ models });

afterEach(() => {
  vi.useRealTimers();
  clearLiveCatalogCacheForTests();
  fetchGuard.mockReset();
});

it("preserves HTTP catalog availability and releases admitted bodies before teardown", async () => {
  for (const mode of ["shared", "abandoned", "capacity"] as const) {
    const responseReady = createDeferredCore<ServerResponse>();
    const firstChunkRead = createDeferredCore();
    const released = createDeferredCore();
    let response: ServerResponse | undefined;
    let requests = 0;
    const reserved = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((_request, reply) => {
          requests += 1;
          response = reply;
          reply.setHeader("content-type", "application/json");
          reply.write('{"data":[');
          responseReady.resolve(reply);
        }),
    });
    const controllers = [new AbortController(), new AbortController()];
    const pending: Array<Promise<unknown>> = [];
    const heldCompletion = createDeferredCore<string>();
    const held =
      mode === "capacity"
        ? Array.from({ length: 100 }, (_, index) =>
            getCachedLiveCatalogValue({
              keyParts: ["held-http-catalog", index],
              load: () => heldCompletion.promise,
            }),
          )
        : [];
    const releases: Array<() => Promise<void>> = [];
    const restoreReaders: Array<() => void> = [];
    const observedGuard: LiveModelCatalogFetchGuard = async (params) => {
      const result = await fetchWithSsrFGuard({
        ...params,
        requireHttps: false,
        policy: { allowPrivateNetwork: true, hostnameAllowlist: ["127.0.0.1"] },
        dispatcherPolicy: { mode: "direct" },
      });
      releases.push(result.release);
      const body = result.response.body;
      assert(body, "Expected the real catalog response body");
      const getReader = body.getReader.bind(body);
      const readerSpy = vi.spyOn(body, "getReader").mockImplementation(() => {
        const reader = getReader();
        const read = reader.read.bind(reader);
        const readSpy = vi.spyOn(reader, "read").mockImplementation(async () => {
          const chunk = await read();
          if (!chunk.done && chunk.value.byteLength > 0) {
            firstChunkRead.resolve();
          }
          return chunk;
        });
        restoreReaders.push(() => readSpy.mockRestore());
        return reader;
      });
      restoreReaders.push(() => readerSpy.mockRestore());
      return {
        ...result,
        release: async () => {
          await result.release();
          released.resolve();
        },
      };
    };
    fetchGuard.mockImplementation(observedGuard);
    const baseUrl = `http://127.0.0.1:${reserved.claim.port}/${mode}`;
    const acquire = (signal: AbortSignal) =>
      mode === "capacity"
        ? buildCatalog({
            providerId: "demo",
            buildProvider: () => ({ ...seed, baseUrl }),
            discoveryMode: "strict",
            ctx: catalogContext(signal),
          })
        : readModels({
            providerId: "demo",
            endpoint: `${baseUrl}/models`,
            requireHttps: false,
            signal,
            fetchGuard: observedGuard,
          });
    try {
      pending.push(acquire(controllers[0]!.signal));
      if (mode === "shared") {
        pending.push(acquire(controllers[1]!.signal));
      }
      // Observe caller cancellation before releasing the held response body.
      const settled = Promise.allSettled(pending);
      await Promise.race([
        firstChunkRead.promise,
        pending[0]!.then(() => {
          throw new Error("Catalog completed before the held body was read");
        }),
      ]);
      const reply = await responseReady.promise;
      if (mode === "capacity") {
        reply.end('{"id":"known"}]}');
        const expected = {
          provider: { models: seed.models },
          outcomes: [{ provider: "demo", status: "ready" }],
        };
        await expect(pending[0]).resolves.toMatchObject(expected);
        await expect(acquire(controllers[0]!.signal)).resolves.toMatchObject(expected);
      } else {
        const reason = new Error("catalog consumer closed");
        controllers[0]!.abort(reason);
        await expect(pending[0]).rejects.toBe(reason);
        if (mode === "abandoned") {
          pending.push(acquire(controllers[1]!.signal));
        }
        reply.end('{"id":"known"}]}');
        await expect(pending[1]).resolves.toEqual([{ id: "known" }]);
        if (mode === "abandoned") {
          await released.promise;
          await expect(acquire(controllers[1]!.signal)).resolves.toEqual([{ id: "known" }]);
        }
      }
      await released.promise;
      await settled;
      expect(requests).toBe(1);
    } finally {
      try {
        controllers.forEach((controller) => controller.abort());
        heldCompletion.resolve("settled");
        response?.destroy();
        reserved.listener.closeAllConnections();
        await Promise.allSettled([...pending, ...held]);
        await Promise.all(releases.map((release) => release()));
      } finally {
        restoreReaders.forEach((restore) => restore());
        await reserved.releaseListener().finally(() => reserved.claim.release());
      }
    }
  }
});

it("family adapter reports cancellation while admitted metadata finishes", async () => {
  const controller = new AbortController();
  const held = holdCatalog({ data: [{ id: "known" }] });
  const pending = buildFamily({
    ...familyOptions,
    entries: [familyEntry("demo", seed.baseUrl, "Demo")],
  }).catalog.run(catalogContext(controller.signal));
  try {
    await held.started;
    controller.abort(new Error("Catalog owner closed"));
    await expect(pending).resolves.toMatchObject({
      outcomes: [{ provider: "demo", status: "unavailable" }],
    });
    expect(fetchGuard).toHaveBeenCalledOnce();
  } finally {
    held.finish();
    await held.released;
    await pending;
  }
});

it("preserves failure, caches authoritative empty until expiry and supports bypass", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
  const release = vi.fn(async () => {});
  const failure = new Error("catalog transport unavailable");
  fetchGuard
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(catalogResponse({ data: [] }, release))
    .mockImplementation(async () => catalogResponse({ data: [{ id: "known" }] }, release));
  const strict = { ...catalogParams, discoveryMode: "strict" as const };
  const acquire = (ttlMs = 1_000) => buildLive({ ...strict, ttlMs });
  await expect(acquire()).rejects.toBe(failure);
  expect(fetchGuard).toHaveBeenCalledTimes(1);
  await expect(acquire()).resolves.toMatchObject({ models: [] });
  await expect(acquire()).resolves.toMatchObject({ models: [] });
  expect(fetchGuard).toHaveBeenCalledTimes(2);
  vi.setSystemTime(999);
  await expect(acquire()).resolves.toMatchObject({ models: [] });
  expect(fetchGuard).toHaveBeenCalledTimes(2);
  await expect(acquire(0)).resolves.toMatchObject({ models: seed.models });
  await expect(acquire()).resolves.toMatchObject({ models: [] });
  expect(fetchGuard).toHaveBeenCalledTimes(3);
  vi.setSystemTime(1_000);
  await expect(acquire()).resolves.toMatchObject({ models: seed.models });
  await expect(acquire()).resolves.toMatchObject({ models: seed.models });
  expect(fetchGuard).toHaveBeenCalledTimes(4);
  expect(release).toHaveBeenCalledTimes(3);
});

it("separates concurrent strict and advisory calls", async () => {
  const held = holdCatalog({ data: [] });
  const acquire = (mode: "strict" | "advisory") =>
    buildLive({
      ...catalogParams,
      discoveryMode: mode === "strict" ? "strict" : undefined,
      projectRows,
    });
  const first = acquire("strict");
  const second = acquire("advisory");
  const startedRequests = fetchGuard.mock.calls.length;
  held.finish();
  await expectModels(first, []);
  await expectModels(second);
  expect(startedRequests).toBe(2);
  await expectModels(acquire("strict"), []);
  expect(fetchGuard).toHaveBeenCalledTimes(2);
  await expectModels(acquire("advisory"));
  await expectModels(acquire("strict"), []);
  expect([fetchGuard, held.release].map((mock) => mock.mock.calls.length)).toEqual([3, 3]);
});

it("preserves auth isolation with custom key parts", async () => {
  const release = vi.fn(async () => {});
  fetchGuard
    .mockResolvedValueOnce(catalogResponse({ data: [] }, release))
    .mockImplementation(async ({ url }) =>
      catalogResponse({ data: [{ id: "known" }] }, release, url),
    );
  const params = {
    ...catalogParams,
    discoveryMode: "strict" as const,
    discoveryApiKey: "synthetic-resolved-first",
    cacheKeyParts: ["shared-catalog"],
    projectRows,
  };
  const changed = { ...params, discoveryApiKey: "synthetic-resolved-second" };
  await expectModels(buildLive(params), []);
  await expectModels(buildLive(changed));
  await expectModels(buildLive(changed));
  await expectModels(buildLive(params), []);
  expect([fetchGuard, release].map((mock) => mock.mock.calls.length)).toEqual([2, 2]);
});

it.each([401, 503])(
  "HTTP %s preserves a healthy family sibling and captured auth",
  async (status) => {
    const release = vi.fn(async () => {});
    fetchGuard.mockImplementation(async ({ url, init }) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer resolved-family-key");
      return {
        response: url.includes("unavailable")
          ? Response.json({}, { status })
          : Response.json({ data: [{ id: "known" }] }),
        finalUrl: url,
        release,
      };
    });
    const family = buildFamily({
      ...familyOptions,
      entries: ["unavailable", "healthy"].map((id) => familyEntry(id, `https://${id}.example/v1`)),
    });
    const resolveProviderApiKey = vi.fn(() => ({
      apiKey: "family:profile",
      discoveryApiKey: "resolved-family-key",
      profileId: "family:profile",
    }));
    const resolveProviderAuth = vi.fn(catalogContext().resolveProviderAuth);
    await expect(
      family.catalog.run({ config: {}, env: {}, resolveProviderApiKey, resolveProviderAuth }),
    ).resolves.toMatchObject({
      providers: { healthy: { models: seed.models } },
      outcomes: [
        {
          provider: "unavailable",
          profileId: "family:profile",
          status: status === 401 ? "auth-rejected" : "unavailable",
          ...(status === 401 ? { rejectionScope: "catalog" } : {}),
        },
        { provider: "healthy", profileId: "family:profile", status: "ready" },
      ],
    });
    expect(resolveProviderApiKey).toHaveBeenCalledOnce();
    expect(resolveProviderAuth).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(2);
  },
);
