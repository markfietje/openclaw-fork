// Signal tests cover setup adapter integration with account-owned transport policy.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { prepareSignalSetupInput, signalSetupAdapter } from "./setup-core.js";

describe("signalSetupAdapter", () => {
  it("uses the setup transport allocator for a second managed account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: { work: { account: "+15555550124" } },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "work",
      input: { signalNumber: "+15555550124" },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "managed-native",
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
  });

  it("stores an explicitly selected container endpoint", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {},
      accountId: "work",
      input: {
        signalNumber: "+15555550124",
        httpUrl: "http://signal-container:8080/",
        signalTransport: "container",
      },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:8080",
    });
  });

  it("detects and persists an omitted HTTP transport kind", async () => {
    const input = await prepareSignalSetupInput({
      input: {
        signalNumber: "+15555550124",
        httpUrl: "signal-container:8080",
      },
      detect: vi.fn().mockResolvedValue({
        kind: "container",
        url: "http://signal-container:8080",
      }),
    });
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {},
      accountId: "work",
      input,
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:8080",
    });
  });

  it("rejects a transport kind without an HTTP URL", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {},
        accountId: "work",
        input: { signalTransport: "container" },
      }),
    ).toBe("Signal --signal-transport requires --http-url.");
  });
});
