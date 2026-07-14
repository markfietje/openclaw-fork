// Signal tests cover doctor contract api plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { migrateLegacySignalTransportConfig } from "./src/config-compat.js";
import { signalDoctor } from "./src/doctor.js";

function signalConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { signal: entry } } as never;
}

describe("signal streaming legacy config rules", () => {
  const rootRule = legacyConfigRules.find((rule) => rule.path.join(".") === "channels.signal");
  const accountRule = legacyConfigRules.find(
    (rule) => rule.path.join(".") === "channels.signal.accounts",
  );

  it("matches flat delivery aliases at root and account level", () => {
    expect(rootRule?.match?.({ chunkMode: "newline" }, {})).toBe(true);
    expect(rootRule?.match?.({ blockStreaming: true }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { chunkMode: "newline" } }, {})).toBe(false);
    expect(accountRule?.match?.({ personal: { blockStreamingCoalesce: { idleMs: 5 } } }, {})).toBe(
      true,
    );
    expect(
      accountRule?.match?.({ personal: { streaming: { block: { enabled: true } } } }, {}),
    ).toBe(false);
  });
});

describe("signal normalizeCompatibilityConfig streaming aliases", () => {
  it("moves flat delivery aliases and seeds materialized account objects from root", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        chunkMode: "newline",
        blockStreaming: true,
        accounts: {
          personal: {
            blockStreamingCoalesce: { idleMs: 250 },
          },
        },
      }),
    });

    const signal = result.config.channels?.signal as unknown as Record<string, unknown>;
    expect(signal.streaming).toEqual({ chunkMode: "newline", block: { enabled: true } });
    expect(signal.chunkMode).toBeUndefined();
    expect(signal.blockStreaming).toBeUndefined();
    const personal = expectDefined(
      (signal.accounts as Record<string, Record<string, unknown>>).personal,
      "personal signal account",
    );
    // Signal's account merge replaces the root streaming object wholesale, so
    // the account object migration materializes must carry the inherited root
    // settings or `doctor --fix` would silently drop them for this account.
    expect(personal.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: true, coalesce: { idleMs: 250 } },
    });
    expect(personal.blockStreamingCoalesce).toBeUndefined();
    expect(result.changes).toContain(
      "Copied channels.signal.streaming into channels.signal.accounts.personal.streaming to keep inherited settings while migrating flat streaming keys.",
    );
  });

  it("is idempotent: a second run reports no changes", () => {
    const first = normalizeCompatibilityConfig({
      cfg: signalConfig({
        chunkMode: "newline",
        accounts: { personal: { blockStreaming: false } },
      }),
    });
    expect(first.changes.length).toBeGreaterThan(0);

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });
});

describe("signal transport compatibility", () => {
  it("migrates an explicit container mode and materializes named account ownership", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "container",
        httpUrl: "http://signal:8080",
        accounts: { work: { account: "+15555550123" } },
      }),
    });
    const signal = result.config.channels?.signal;

    expect(signal?.transport).toBeUndefined();
    expect(signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://signal:8080",
    });
    expect(signal).not.toHaveProperty("apiMode");
    expect(signal).not.toHaveProperty("httpUrl");
  });

  it("migrates managed native process fields into transport", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        cliPath: "/opt/signal-cli",
        configPath: "/var/lib/signal",
        httpPort: 8181,
        ignoreAttachments: true,
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      cliPath: "/opt/signal-cli",
      configPath: "/var/lib/signal",
      httpPort: 8181,
    });
    expect(result.config.channels?.signal?.ignoreAttachments).toBe(true);
    expect(result.config.channels?.signal).not.toHaveProperty("cliPath");
  });

  it("keeps attachment suppression account-owned for external transports", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "container",
        httpUrl: "signal:8080",
        ignoreAttachments: true,
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal:8080",
    });
    expect(result.config.channels?.signal?.ignoreAttachments).toBe(true);
  });

  it("preserves an inherited custom port for the first named managed account", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        httpPort: 8181,
        accounts: {
          work: { account: "+15555550123" },
          alerts: { account: "+15555550124" },
        },
      }),
    });

    expect(result.config.channels?.signal?.transport).toBeUndefined();
    expect(result.config.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8181,
    });
    expect(result.config.channels?.signal?.accounts?.alerts?.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8080,
    });
  });

  it("allocates distinct managed ports while materializing named account ownership", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        account: "+15555550123",
        httpPort: 8080,
        accounts: { work: { account: "+15555550124" } },
      }),
    });

    expect(result.config.channels?.signal?.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8080,
    });
    expect(result.config.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8081,
    });
  });

  it("defers auto endpoint migration until doctor can detect it", () => {
    const cfg = signalConfig({ apiMode: "auto", httpUrl: "http://signal:8080" });
    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });

  it("detects an auto endpoint once and persists the concrete result", async () => {
    const detect = vi.fn().mockResolvedValue({
      kind: "external-native",
      url: "http://signal:8080",
    });
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "auto",
        httpUrl: "http://signal:8080/",
        account: "+15555550123",
      }),
      detect,
    });

    expect(detect).toHaveBeenCalledWith({
      url: "http://signal:8080",
      account: "+15555550123",
    });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://signal:8080",
    });
    expect(result.config.channels?.signal).not.toHaveProperty("apiMode");

    const second = await migrateLegacySignalTransportConfig({ cfg: result.config, detect });
    expect(second.config).toBe(result.config);
    expect(second.changes).toEqual([]);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("detects auto endpoints even when legacy autoStart is false", async () => {
    const detect = vi.fn().mockResolvedValue({
      kind: "container",
      url: "http://signal:8080",
    });
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "auto",
        autoStart: false,
        httpUrl: "http://signal:8080",
      }),
      detect,
    });

    expect(detect).toHaveBeenCalledTimes(1);
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal:8080",
    });
  });

  it("detects auto host and port endpoints before choosing a concrete transport", async () => {
    const detect = vi.fn().mockResolvedValue({
      kind: "container",
      url: "http://signal:8181",
    });
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "auto",
        autoStart: false,
        httpHost: "signal",
        httpPort: 8181,
      }),
      detect,
    });

    expect(detect).toHaveBeenCalledWith({ url: "http://signal:8181" });
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal:8181",
    });
  });

  it("keeps explicit native auto-start endpoints managed", async () => {
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "native",
        autoStart: true,
        httpUrl: "http://127.0.0.1:8181",
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      httpHost: "127.0.0.1",
      httpPort: 8181,
    });
  });

  it("leaves an unreachable auto endpoint unchanged for a later doctor run", async () => {
    const cfg = signalConfig({ apiMode: "auto", httpUrl: "http://offline:8080" });
    const result = await migrateLegacySignalTransportConfig({
      cfg,
      detect: vi.fn().mockRejectedValue(new Error("offline")),
    });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });

  it("warns when auto detection still needs a reachable legacy endpoint", async () => {
    expect(
      signalDoctor.collectPreviewWarnings?.({
        cfg: signalConfig({ apiMode: "auto", httpUrl: "http://offline:8080" }),
        doctorFixCommand: "openclaw doctor --fix",
        env: {},
      }),
    ).toEqual([
      "- channels.signal: legacy auto transport needs a reachable daemon before it can be migrated; start the configured endpoint, then run openclaw doctor --fix.",
    ]);
  });
});
