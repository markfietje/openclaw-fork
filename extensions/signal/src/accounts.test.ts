// Signal tests cover accounts plugin behavior.
import { describe, expect, it } from "vitest";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./accounts.js";

describe("resolveSignalAccount", () => {
  it("resolves an omitted transport to managed native defaults", () => {
    const resolved = resolveSignalAccount({ cfg: { channels: { signal: {} } } as never });

    expect(resolved.transport).toEqual({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8080",
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      startupTimeoutMs: 30_000,
    });
  });

  it("does not inherit the default account transport into named accounts", () => {
    const cfg = {
      channels: {
        signal: {
          transport: {
            kind: "container",
            url: "http://default-container:8080",
          },
          accounts: {
            work: {
              account: "+15555550123",
            },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg }).transport).toEqual({
      kind: "container",
      baseUrl: "http://default-container:8080",
    });
    expect(resolveSignalAccount({ cfg, accountId: "work" }).transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8080",
    });
  });

  it("keeps the root transport authoritative over accounts.default", () => {
    const cfg = {
      channels: {
        signal: {
          transport: { kind: "external-native", url: "http://canonical-native:8181" },
          accounts: {
            default: {
              account: "+15555550123",
              transport: { kind: "container", url: "http://stale-container:8080" },
            },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "default" }).transport).toEqual({
      kind: "external-native",
      baseUrl: "http://canonical-native:8181",
    });
  });

  it("allocates distinct default ports across managed native accounts", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            personal: { account: "+15555550123", transport: { kind: "managed-native" } },
            work: { account: "+15555550124", transport: { kind: "managed-native" } },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "personal" }).transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8080,
    });
    expect(resolveSignalAccount({ cfg, accountId: "work" }).transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8081,
    });
  });

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultSignalAccountId(cfg)).toBe("default");
    expect(resolveSignalAccount({ cfg }).config.account).toBe("+15555550123");
  });

  it("discovers an accountUuid-only default account alongside named accounts", () => {
    const cfg = {
      channels: {
        signal: {
          accountUuid: "123e4567-e89b-12d3-a456-426614174000",
          accounts: {
            work: { account: "+15555550123" },
          },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveSignalAccount({ cfg }).configured).toBe(true);
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            defaultAccount: "work",
            accounts: {
              work: {
                name: "Work",
                account: "+15555550123",
                transport: {
                  kind: "external-native",
                  url: "http://127.0.0.1:9999",
                },
              },
            },
          },
        },
      } as never,
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.baseUrl).toBe("http://127.0.0.1:9999");
    expect(resolved.transport).toEqual({
      kind: "external-native",
      baseUrl: "http://127.0.0.1:9999",
    });
    expect(resolved.config.account).toBe("+15555550123");
    expect(resolved.configured).toBe(true);
  });
});
