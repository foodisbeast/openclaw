import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveGatewayInteractiveSurfaceAuth as interactiveAuth,
  resolveGatewayProbeSurfaceAuth as probeAuth,
} from "./auth-surface-resolution.js";

const ambientAuth: NodeJS.ProcessEnv = {
  OPENCLAW_GATEWAY_TOKEN: "ambient-token",
  OPENCLAW_GATEWAY_PASSWORD: "ambient-password", // pragma: allowlist secret
};

function missingSecretRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function params(
  gateway: NonNullable<OpenClawConfig["gateway"]>,
  surface: "local" | "remote" = "local",
  env = ambientAuth,
) {
  const config: OpenClawConfig = {
    gateway,
    secrets: { providers: { default: { source: "env" } } },
  };
  return { config, surface, env };
}

const token = missingSecretRef("MISSING_LOCAL_TOKEN");
const password = missingSecretRef("MISSING_LOCAL_PASSWORD");
const remoteToken = params(
  { remote: { token: missingSecretRef("MISSING_REMOTE_TOKEN") } },
  "remote",
);
const remotePassword = params(
  { remote: { password: missingSecretRef("MISSING_REMOTE_PASSWORD") } },
  "remote",
);

describe("Gateway auth surface resolution", () => {
  it.each([
    ["local token mode", params({ auth: { mode: "token", token } }), "gateway.auth.token"],
    ["implicit local token mode", params({ auth: { token } }), "gateway.auth.token"],
    [
      "local password mode",
      params({ auth: { mode: "password", password } }),
      "gateway.auth.password",
    ],
    ["implicit local password mode", params({ auth: { password } }), "gateway.auth.password"],
    ["remote token", remoteToken, "gateway.remote.token"],
    ["remote password", remotePassword, "gateway.remote.password"],
  ] as const)(
    "keeps unavailable %s refs authoritative across probe and interactive surfaces",
    async (_label, request, path) => {
      const [probe, interactive] = await Promise.all([
        probeAuth(request),
        interactiveAuth(request),
      ]);
      expect([probe.token, probe.password, probe.source]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(probe.diagnostics).toEqual([
        expect.stringContaining(`${path} SecretRef is unresolved`),
      ]);
      expect([interactive.token, interactive.password]).toEqual([undefined, undefined]);
      expect(interactive.failureReason).toContain(`${path} SecretRef is unresolved`);
    },
  );

  it("preserves a healthy configured remote password when its sibling token ref fails", async () => {
    const request = params(
      {
        remote: {
          token: missingSecretRef("MISSING_REMOTE_TOKEN"),
          password: "configured-password", // pragma: allowlist secret
        },
      },
      "remote",
    );
    const [probe, interactive] = await Promise.all([probeAuth(request), interactiveAuth(request)]);

    expect(probe).toEqual({
      token: undefined,
      password: "configured-password", // pragma: allowlist secret
      source: "config",
      diagnostics: [expect.stringContaining("gateway.remote.token SecretRef is unresolved")],
    });
    expect(interactive).toEqual({
      token: undefined,
      password: "configured-password", // pragma: allowlist secret
    });
  });

  it.each([
    { mode: "password", inactiveCredential: "token" },
    { mode: "token", inactiveCredential: "password" },
  ] as const)(
    "ignores an unavailable $inactiveCredential ref when explicit $mode mode selects its sibling",
    async ({ mode, inactiveCredential }) => {
      await expect(
        probeAuth(
          params({
            auth: {
              mode,
              [mode]: `configured-${mode}`,
              [inactiveCredential]: missingSecretRef("MISSING_INACTIVE_CREDENTIAL"),
            },
          }),
        ),
      ).resolves.toEqual({ [mode]: `configured-${mode}`, source: "config" });
    },
  );

  it.each([
    {
      label: "remote token",
      request: remoteToken,
      explicitAuth: { token: "explicit-token" },
      expected: { token: "explicit-token", password: undefined },
    },
    {
      label: "local password overriding token mode",
      request: params({ auth: { mode: "token", token } }),
      explicitAuth: { password: "explicit-password" }, // pragma: allowlist secret
      expected: { token: undefined, password: "explicit-password" }, // pragma: allowlist secret
    },
  ] as const)(
    "keeps explicit $label authoritative over unavailable configured refs",
    async (testCase) => {
      await expect(
        interactiveAuth({
          ...testCase.request,
          explicitAuth: testCase.explicitAuth,
        }),
      ).resolves.toEqual(testCase.expected);
    },
  );

  it("keeps a resolved remote password ref ahead of ambient password", async () => {
    await expect(
      interactiveAuth(
        params(
          {
            remote: { password: missingSecretRef("REMOTE_PASSWORD") },
          },
          "remote",
          { ...ambientAuth, REMOTE_PASSWORD: "resolved-remote-password" },
        ),
      ),
    ).resolves.toEqual({ token: undefined, password: "resolved-remote-password" }); // pragma: allowlist secret
  });
});
