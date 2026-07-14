// Signal tests cover setup adapter integration with account-owned transport policy.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { signalSetupAdapter } from "./setup-core.js";

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

  it("keeps an http URL external-native by default", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {},
      accountId: "work",
      input: {
        signalNumber: "+15555550124",
        httpUrl: "http://native-signal:8080",
      },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "external-native",
      url: "http://native-signal:8080",
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
