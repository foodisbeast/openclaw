// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { deviceSystemInfo } from "../test-helpers/devices-fixtures.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { readSystemInfo } from "./system-info.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(
  response: typeof deviceSystemInfo | Promise<typeof deviceSystemInfo> = deviceSystemInfo,
  hello = gatewayHelloForMethods(["system.info"]),
) {
  const request = vi.fn().mockReturnValue(Promise.resolve(response));
  const current = createApplicationGateway({
    phase: "connected",
    client: { request } as GatewayBrowserClient,
    hello,
  } as ApplicationGatewaySnapshot);
  return {
    ...current,
    request,
    read: readSystemInfo.bind(undefined, current.gateway),
    transportAborted: () => request.mock.calls[0]?.[2].signal.aborted,
  };
}
const aborted = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ name: "AbortError" });

it.each([
  ["session-only", ["operator.sessions.read", "operator.sessions.write"], true],
  ["unadvertised", ["operator.admin"], false],
] as const)("blocks unavailable %s connections", async (_name, scopes, advertised) => {
  const { read, request } = setup(
    deviceSystemInfo,
    gatewayHelloForMethods(advertised ? ["system.info"] : [], scopes),
  );
  await aborted(read());
  expect(request).not.toHaveBeenCalled();
});

const changes = ["scopes", "client", "hello", "credentials"] as const;
it.each(changes)("retires pending and cached %s samples", async (change) => {
  vi.useFakeTimers();
  for (const settled of [false, true]) {
    const pending = createDeferred<typeof deviceSystemInfo>();
    const { read, request, gateway, publish, transportAborted } = setup(pending.promise);
    const refreshed = { ...deviceSystemInfo, machineName: "New host" };
    request.mockReturnValueOnce(pending.promise).mockResolvedValue(refreshed);
    const signal = new AbortController().signal;
    const result = read(signal);
    const rejected = settled ? undefined : aborted(result);
    if (settled) {
      pending.resolve(deviceSystemInfo);
      expect((await result).value).toEqual(deviceSystemInfo);
    }
    if (change === "scopes") {
      gateway.snapshot.hello!.auth!.scopes = ["operator.sessions.read"];
    } else if (change === "credentials") {
      Object.assign(gateway, { connectionRevision: 1 });
    } else {
      publish({
        ...gateway.snapshot,
        ...(change === "client"
          ? { client: { request } as GatewayBrowserClient }
          : { hello: gatewayHelloForMethods(["system.info"]) }),
      });
    }
    if (!settled) {
      pending.resolve(deviceSystemInfo);
      await rejected;
      expect(transportAborted()).toBe(true);
    }
    if (change === "scopes") {
      await aborted(read());
      expect(request).toHaveBeenCalledOnce();
      expect(transportAborted()).toBe(true);
      gateway.snapshot.hello!.auth!.scopes = ["operator.read"];
    }
    expect((await read(signal)).value).toEqual(refreshed);
    expect(request).toHaveBeenCalledTimes(2);
  }
});

it("defers hidden reads until a visible consumer returns", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const { read, request } = setup();
  await aborted(read());
  expect(request).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  expect((await read()).value).toEqual(deviceSystemInfo);
  expect(request).toHaveBeenCalledOnce();
});

it("shares pending manual reads, preserves sample metadata, and refreshes only settled results", async () => {
  vi.useFakeTimers();
  const pending = createDeferred<typeof deviceSystemInfo>();
  const { read, request, transportAborted } = setup(pending.promise);
  const leaving = new AbortController();
  const remaining = new AbortController();
  const rejected = aborted(read(leaving.signal));
  const second = read(remaining.signal, { fresh: true });
  leaving.abort();
  await rejected;
  expect(transportAborted()).toBe(false);
  await vi.advanceTimersByTimeAsync(72);
  pending.resolve(deviceSystemInfo);
  const sample = await second;
  expect(sample.roundTripMs).toBe(72);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await read(remaining.signal)).toEqual(sample);
  expect(request).toHaveBeenCalledOnce();
  const refreshed = { ...deviceSystemInfo, machineName: "Refreshed host" };
  request.mockResolvedValueOnce(refreshed);
  expect((await read(remaining.signal, { fresh: true })).value).toEqual(refreshed);
  expect((await read(remaining.signal)).value).toEqual(refreshed);
  expect(request).toHaveBeenCalledTimes(2);
});
