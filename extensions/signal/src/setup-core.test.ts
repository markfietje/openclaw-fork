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

  it("preserves managed transport options during a partial setup update", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            work: {
              account: "+15555550124",
              transport: {
                kind: "managed-native",
                cliPath: "/opt/old-signal-cli",
                configPath: "/var/lib/signal-work",
                httpHost: "127.0.0.2",
                httpPort: 8181,
                receiveMode: "manual",
                ignoreStories: true,
              },
            },
          },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "work",
      input: { cliPath: "/opt/new-signal-cli" },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "managed-native",
      cliPath: "/opt/new-signal-cli",
      configPath: "/var/lib/signal-work",
      httpHost: "127.0.0.2",
      httpPort: 8181,
      receiveMode: "manual",
      ignoreStories: true,
    });
  });

  it("makes a new default transport update authoritative over accounts.default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            default: {
              account: "+15555550124",
              transport: { kind: "external-native", url: "http://old-signal:8080" },
            },
          },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "default",
      input: { cliPath: "/opt/new-signal-cli" },
    });

    expect(next?.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      cliPath: "/opt/new-signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });
    expect(next?.channels?.signal?.accounts?.default).not.toHaveProperty("transport");
  });

  it("keeps the canonical root transport during a default account-only update", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          transport: { kind: "external-native", url: "http://canonical-signal:8080" },
          accounts: {
            default: {
              account: "+15555550124",
              transport: { kind: "container", url: "http://stale-container:8080" },
            },
          },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "default",
      input: { signalNumber: "+15555550125" },
    });

    expect(next?.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://canonical-signal:8080",
    });
    expect(next?.channels?.signal?.accounts?.default).not.toHaveProperty("transport");
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

  it("resolves an offline legacy auto endpoint through explicit setup selection", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            apiMode: "auto",
            httpUrl: "http://offline:8080",
            account: "+15555550124",
          },
        },
      } as never,
      accountId: "default",
      input: {
        httpUrl: "http://offline:8080",
        signalTransport: "container",
      },
    });

    expect(next?.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://offline:8080",
    });
    expect(next?.channels?.signal).not.toHaveProperty("apiMode");
    expect(next?.channels?.signal).not.toHaveProperty("httpUrl");
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

  it("does not borrow the root account while detecting a named account transport", async () => {
    const detect = vi.fn().mockResolvedValue({
      kind: "container",
      url: "http://signal-container:8080",
    });

    await prepareSignalSetupInput({
      cfg: {
        channels: {
          signal: { account: "+15555550123" },
        },
      },
      accountId: "work",
      input: { httpUrl: "signal-container:8080" },
      detect,
    });

    expect(detect).toHaveBeenCalledWith({ url: "signal-container:8080" });
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

  it.each(["0", "abc", "65536"])("rejects invalid managed HTTP port %s", (httpPort) => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {},
        accountId: "work",
        input: { httpPort },
      }),
    ).toBe("Signal --http-port must be an integer between 1 and 65535.");
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

  it("does not let a new named container transport borrow the root Signal account", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {
          channels: {
            signal: { account: "+15555550123" },
          },
        },
        accountId: "work",
        input: {
          httpUrl: "http://signal-container:8080",
          signalTransport: "container",
        },
      }),
    ).toBe("Signal container transport requires --signal-number or an existing account.");
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

  it("reports an external transport as configured without checking signal-cli", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550124",
          transport: { kind: "external-native", url: "http://signal:8080" },
        },
      },
    };
    const configured = await signalSetupWizard.status.resolveConfigured({
      cfg,
      accountId: "default",
    });
    const params = { cfg, accountId: "default", configured };

    await expect(signalSetupWizard.status.resolveStatusLines?.(params)).resolves.toEqual([
      "Signal: configured",
    ]);
    await expect(signalSetupWizard.status.resolveSelectionHint?.(params)).resolves.toBe(
      "configured",
    );
    await expect(signalSetupWizard.status.resolveQuickstartScore?.(params)).resolves.toBe(1);
  });
});
