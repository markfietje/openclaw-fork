// Signal tests cover setup adapter integration with account-owned transport policy.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createSignalCliPathTextInput,
  prepareSignalSetupInput,
  signalSetupAdapter,
} from "./setup-core.js";
import { signalSetupWizard } from "./setup-surface.js";

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

  it("uses the configured account while detecting an omitted HTTP transport kind", async () => {
    const detect = vi.fn().mockResolvedValue({
      kind: "container",
      url: "http://signal-container:8080",
    });

    await prepareSignalSetupInput({
      cfg: {
        channels: {
          signal: {
            accounts: {
              work: { account: "+15555550124" },
            },
          },
        },
      },
      accountId: "work",
      input: { httpUrl: "signal-container:8080" },
      detect,
    });

    expect(detect).toHaveBeenCalledWith({
      url: "signal-container:8080",
      account: "+15555550124",
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

  it("rejects a fresh container transport without a Signal account", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {},
        accountId: "work",
        input: {
          httpUrl: "http://signal-container:8080",
          signalTransport: "container",
        },
      }),
    ).toBe("Signal container transport requires --signal-number or an existing account.");
  });

  it("allows a container transport to reuse the configured Signal account", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {
          channels: {
            signal: {
              accounts: { work: { account: "+15555550124" } },
            },
          },
        },
        accountId: "work",
        input: {
          httpUrl: "http://signal-container:8080",
          signalTransport: "container",
        },
      }),
    ).toBeNull();
  });

  it("does not materialize a CLI path for an external transport", async () => {
    const input = createSignalCliPathTextInput(async () => false);
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550124",
          transport: { kind: "container", url: "http://signal:8080" },
        },
      },
    };

    expect(
      await input.currentValue?.({ cfg, accountId: "default", credentialValues: {} }),
    ).toBeUndefined();
    const wizardInput = signalSetupWizard.textInputs?.find((entry) => entry.inputKey === "cliPath");
    expect(
      await wizardInput?.shouldPrompt?.({
        cfg,
        accountId: "default",
        credentialValues: {},
      }),
    ).toBe(false);
  });
});
