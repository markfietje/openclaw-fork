// Signal tests cover the setup-facing transport contract.
import { describe, expect, it, vi } from "vitest";
import { resolveSignalAccount } from "./accounts.js";
import {
  detectSignalTransport,
  prepareSignalManagedNativeTransport,
  probeSignalTransport,
  writeSignalAccountTransport,
} from "./setup-transport.js";

describe("detectSignalTransport", () => {
  it("prefers native deterministically when both endpoints are healthy", async () => {
    const transport = await detectSignalTransport({
      url: "http://signal:8080",
      probeNative: vi.fn().mockResolvedValue({ ok: true }),
      probeContainer: vi.fn().mockResolvedValue({ ok: true }),
    });

    expect(transport).toEqual({ kind: "external-native", url: "http://signal:8080" });
  });

  it("selects container only when its endpoint is healthy", async () => {
    const probeContainer = vi.fn().mockResolvedValue({ ok: true });
    const transport = await detectSignalTransport({
      url: "http://signal:8080/",
      account: "+15555550123",
      probeNative: vi.fn().mockResolvedValue({ ok: false }),
      probeContainer,
    });

    expect(transport).toEqual({ kind: "container", url: "http://signal:8080" });
    expect(probeContainer).toHaveBeenCalledWith("http://signal:8080", 10_000, "+15555550123");
  });

  it("rejects an endpoint that matches neither transport", async () => {
    await expect(
      detectSignalTransport({
        url: "http://signal:8080",
        probeNative: vi.fn().mockResolvedValue({ ok: false }),
        probeContainer: vi.fn().mockResolvedValue({ ok: false }),
      }),
    ).rejects.toThrow("Signal transport not reachable at http://signal:8080");
  });
});

describe("prepareSignalManagedNativeTransport", () => {
  it("allocates distinct ports for managed native accounts", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: { work: { account: "+15555550124" } },
        },
      },
    } as const;

    expect(prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" })).toEqual({
      kind: "managed-native",
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
  });

  it("preserves an existing implicit port when adding a lexically earlier account", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            work: { account: "+15555550124", transport: { kind: "managed-native" } },
          },
        },
      },
    } as const;

    expect(resolveSignalAccount({ cfg: cfg as never, accountId: "work" }).transport).toMatchObject({
      httpPort: 8080,
    });
    const transport = prepareSignalManagedNativeTransport({
      cfg: cfg as never,
      accountId: "personal",
    });
    const next = writeSignalAccountTransport({
      cfg: cfg as never,
      accountId: "personal",
      transport,
    });

    expect(transport.httpPort).toBe(8081);
    expect(resolveSignalAccount({ cfg: next, accountId: "work" }).transport).toMatchObject({
      httpPort: 8080,
    });
  });

  it("preserves managed options behind a case-preserving account key", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            Ops: {
              account: "+15555550124",
              transport: {
                kind: "managed-native",
                cliPath: "/opt/signal-cli",
                httpPort: 8181,
              },
            },
          },
        },
      },
    } as const;

    expect(prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "ops" })).toEqual({
      kind: "managed-native",
      cliPath: "/opt/signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8181,
    });
  });

  it("reserves a configured default account when setup will re-enable the channel", () => {
    const cfg = {
      channels: {
        signal: {
          enabled: false,
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: { work: { account: "+15555550124" } },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" }).httpPort,
    ).toBe(8081);
  });

  it("reserves ports owned by disabled named accounts", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            dormant: {
              enabled: false,
              account: "+15555550123",
              transport: { kind: "managed-native", httpPort: 8080 },
            },
            work: { account: "+15555550124" },
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" }).httpPort,
    ).toBe(8081);
  });

  it("preserves a selected account's collision-free managed port and options", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: {
            work: {
              account: "+15555550124",
              transport: {
                kind: "managed-native",
                httpHost: "0.0.0.0",
                httpPort: 19089,
                cliPath: "/opt/signal-cli",
              },
            },
          },
        },
      },
    } as const;

    expect(prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" })).toEqual({
      kind: "managed-native",
      httpHost: "0.0.0.0",
      httpPort: 19089,
      cliPath: "/opt/signal-cli",
    });
  });

  it("keeps an aligned managed connection URL on the allocated bind port", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: {
            work: {
              account: "+15555550124",
              transport: {
                kind: "managed-native",
                url: "http://127.0.0.1:8080",
                httpHost: "0.0.0.0",
              },
            },
          },
        },
      },
    } as const;

    expect(prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" })).toEqual({
      kind: "managed-native",
      url: "http://127.0.0.1:8081",
      httpHost: "0.0.0.0",
      httpPort: 8081,
    });
  });

  it("keeps an existing managed connection URL aligned with bind overrides", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: {
            kind: "managed-native",
            url: "http://127.0.0.2:8080",
            httpHost: "127.0.0.2",
            httpPort: 8080,
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({
        cfg: cfg as never,
        accountId: "default",
        overrides: { httpHost: "127.0.0.3", httpPort: 8181 },
      }),
    ).toEqual({
      kind: "managed-native",
      url: "http://127.0.0.3:8181",
      httpHost: "127.0.0.3",
      httpPort: 8181,
    });
  });

  it("reserves a local HTTPS proxy endpoint independently from the daemon bind", () => {
    const cfg = {
      channels: {
        signal: {
          transport: {
            kind: "managed-native",
            url: "https://127.0.0.1:8080",
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "default" }),
    ).toEqual({
      kind: "managed-native",
      url: "https://127.0.0.1:8080",
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
  });

  it("uses IPv6 loopback when an aligned endpoint moves to the IPv6 wildcard bind", () => {
    const cfg = {
      channels: {
        signal: {
          transport: {
            kind: "managed-native",
            url: "http://127.0.0.1:8080",
            httpHost: "127.0.0.1",
            httpPort: 8080,
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({
        cfg: cfg as never,
        accountId: "default",
        overrides: { httpHost: "::" },
      }),
    ).toEqual({
      kind: "managed-native",
      url: "http://[::1]:8080",
      httpHost: "::",
      httpPort: 8080,
    });
  });

  it("reserves ports used by enabled local external transports", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            external: {
              account: "+15555550123",
              transport: { kind: "external-native", url: "http://localhost:8080" },
            },
            work: { account: "+15555550124" },
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" }).httpPort,
    ).toBe(8081);
  });

  it("reserves managed bind and local connection endpoint ports", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            proxy: {
              account: "+15555550123",
              transport: {
                kind: "managed-native",
                url: "http://localhost:8080",
                httpPort: 8181,
              },
            },
            work: { account: "+15555550124" },
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" }).httpPort,
    ).toBe(8081);
  });

  it.each([0, Number.NaN, 65_536])("rejects invalid preferred port %s", (httpPort) => {
    expect(() =>
      prepareSignalManagedNativeTransport({
        cfg: {},
        accountId: "work",
        overrides: { httpPort },
      }),
    ).toThrow("Signal managed native port must be an integer between 1 and 65535.");
  });
});

describe("probeSignalTransport", () => {
  it("probes only the configured concrete transport", async () => {
    const probeNative = vi.fn().mockResolvedValue({ ok: true });
    const probeContainer = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      probeSignalTransport({
        cfg: {},
        accountId: "default",
        transport: { kind: "container", url: "http://signal:8080" },
        account: "+15555550123",
        probeNative,
        probeContainer,
      }),
    ).resolves.toEqual({ ok: true });
    expect(probeNative).not.toHaveBeenCalled();
    expect(probeContainer).toHaveBeenCalledWith("http://signal:8080", 10_000, "+15555550123");
  });

  it("probes the allocated port for an implicit managed account transport", async () => {
    const probeNative = vi.fn().mockResolvedValue({ ok: true });
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: { work: { account: "+15555550124" } },
        },
      },
    } as const;

    await expect(
      probeSignalTransport({
        cfg: cfg as never,
        accountId: "work",
        transport: { kind: "managed-native" },
        probeNative,
      }),
    ).resolves.toEqual({ ok: true });
    expect(probeNative).toHaveBeenCalledWith("http://127.0.0.1:8081", 10_000);
  });
});

describe("writeSignalAccountTransport", () => {
  it("rejects explicit non-HTTP endpoint schemes", () => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {},
        accountId: "default",
        transport: { kind: "external-native", url: "ftp://signal.example" },
      }),
    ).toThrow("Signal transport URL unsupported protocol: ftp:");
  });

  it("writes the implicit default account without changing named accounts", () => {
    const next = writeSignalAccountTransport({
      cfg: {
        channels: {
          signal: {
            dmPolicy: "allowlist",
            apiMode: "native",
            httpUrl: "http://legacy-native:8080",
            autoStart: false,
            accounts: { work: { account: "+15555550123" } },
          },
        },
      } as never,
      accountId: "default",
      transport: { kind: "external-native", url: "http://native:8080" },
    });

    expect(next.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://native:8080",
    });
    expect(next.channels?.signal?.accounts?.work).toEqual({ account: "+15555550123" });
    expect(next.channels?.signal?.dmPolicy).toBe("allowlist");
    expect(next.channels?.signal).not.toHaveProperty("apiMode");
    expect(next.channels?.signal).not.toHaveProperty("httpUrl");
    expect(next.channels?.signal).not.toHaveProperty("autoStart");
  });

  it("makes the canonical root authoritative over a nested default transport", () => {
    const next = writeSignalAccountTransport({
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                account: "+15555550123",
                transport: { kind: "managed-native", httpPort: 8181 },
              },
            },
          },
        },
      } as never,
      accountId: "default",
      transport: { kind: "external-native", url: "http://native:8080" },
    });

    expect(next.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://native:8080",
    });
    expect(next.channels?.signal?.accounts?.default).not.toHaveProperty("transport");
  });

  it("writes only the selected named account", () => {
    const next = writeSignalAccountTransport({
      cfg: { channels: { signal: { transport: { kind: "managed-native" } } } },
      accountId: "work",
      transport: { kind: "container", url: "http://container:8080/" },
    });

    expect(next.channels?.signal?.transport).toEqual({ kind: "managed-native" });
    expect(next.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://container:8080",
    });
  });

  it("normalizes a managed native connection URL", () => {
    const next = writeSignalAccountTransport({
      cfg: { channels: { signal: {} } },
      accountId: "default",
      transport: {
        kind: "managed-native",
        url: "127.0.0.1:8181/",
        httpHost: "0.0.0.0",
        httpPort: 8181,
      },
    });

    expect(next.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      url: "http://127.0.0.1:8181",
      httpHost: "0.0.0.0",
      httpPort: 8181,
    });
  });
});
