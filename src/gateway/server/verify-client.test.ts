import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  validateForwardedHeaderConsistency,
  validateSensitiveHeaders,
} from "../forwarded-headers.js";
import { createGatewayVerifyClient } from "./verify-client.js";

function makeReq(opts: {
  remoteAddress?: string;
  headers?: Record<string, string>;
  rawHeaders?: string[];
  origin?: string;
}): Parameters<ReturnType<typeof createGatewayVerifyClient>>[0] {
  return {
    req: {
      socket: { remoteAddress: opts.remoteAddress },
      headers: opts.headers ?? {},
      rawHeaders: opts.rawHeaders ?? [],
    },
    origin: opts.origin,
  } as never;
}

function verifyOk(opts: Parameters<typeof makeReq>[0]): Promise<boolean> {
  const verifyClient = createGatewayVerifyClient({
    log: { info: () => {}, warn: () => {} },
    getConfigSnapshot: () => baseCfg,
  });
  return new Promise((resolve) => {
    verifyClient(makeReq(opts), (ok: boolean) => resolve(ok));
  });
}

const baseCfg = {
  gateway: {
    trustedProxies: ["127.0.0.1/32"],
    security: {},
    controlUi: { allowedOrigins: ["https://app.example.com"] },
  },
} as unknown as OpenClawConfig;

describe("gateway verifyClient", () => {
  // Regression for rejected PR #35109: the trusted-proxy flag was never wired at
  // the call site, so every X-Forwarded request from a trusted proxy was rejected.
  // These two cases prove gateway.trustedProxies is actually read from config.
  it("accepts a plaintext request from a trusted proxy presenting X-Forwarded-Proto", async () => {
    expect(
      await verifyOk({
        remoteAddress: "127.0.0.1",
        origin: "https://app.example.com",
        headers: {
          host: "gateway.internal",
          "x-forwarded-host": "app.example.com",
          "x-forwarded-proto": "https",
        },
      }),
    ).toBe(true);
  });

  it("rejects forwarded/proto mismatch from an untrusted peer only when strictHeaderValidation is opt-in", async () => {
    // ClawSweeper: every new rejection path must be opt-in. Without the flag,
    // existing proxy deployments with mismatched forwarded proto keep working.
    const cfg = (strict: boolean) =>
      ({
        ...baseCfg,
        gateway: {
          ...baseCfg.gateway!,
          security: { strictHeaderValidation: strict },
        },
      }) as unknown as OpenClawConfig;

    const verifyClient = (strict: boolean) =>
      createGatewayVerifyClient({
        log: { info: () => {}, warn: () => {} },
        getConfigSnapshot: () => cfg(strict),
      });

    const req = makeReq({
      remoteAddress: "198.51.100.7",
      origin: "https://app.example.com",
      headers: {
        host: "gateway.internal",
        "x-forwarded-host": "app.example.com",
        "x-forwarded-proto": "https",
      },
    });

    const run = (strict: boolean) =>
      new Promise<boolean>((resolve) => verifyClient(strict)(req, (ok: boolean) => resolve(ok)));

    expect(await run(false)).toBe(true); // default-off preserves existing proxy traffic
    expect(await run(true)).toBe(false); // opt-in catches the mismatch
  });

  it("rejects cross-site websocket initiations from a browser when opted in", async () => {
    const verifyClient = createGatewayVerifyClient({
      log: { info: () => {}, warn: () => {} },
      getConfigSnapshot: () =>
        ({
          ...baseCfg,
          gateway: {
            ...baseCfg.gateway!,
            security: { rejectCrossSiteWebSocketRequests: true },
          },
        }) as unknown as OpenClawConfig,
    });
    const result = await new Promise<boolean>((resolve) => {
      verifyClient(
        makeReq({
          remoteAddress: "192.0.2.10",
          origin: "https://evil.example.com",
          headers: { host: "gateway.internal", "sec-fetch-site": "cross-site" },
        }),
        (ok: boolean) => resolve(ok),
      );
    });
    expect(result).toBe(false);
  });

  it("allows legitimate loopback cross-site traffic by default (Sec-Fetch-Site gate is opt-in)", async () => {
    // Regression guard: v2026.4.15 shipped loopback-alias support because browsers
    // flag localhost<->127.0.0.1 as Sec-Fetch-Site: cross-site. The gate must not
    // default-on and override checkBrowserOrigin's loopback admission.
    expect(
      await verifyOk({
        remoteAddress: "127.0.0.1",
        origin: "http://localhost:5173",
        headers: {
          host: "127.0.0.1:18789",
          "sec-fetch-site": "cross-site",
        },
      }),
    ).toBe(true);
  });

  it("rejects a literal 'null' browser origin instead of skipping the gate when opted in", async () => {
    const verifyClient = createGatewayVerifyClient({
      log: { info: () => {}, warn: () => {} },
      getConfigSnapshot: () =>
        ({
          ...baseCfg,
          gateway: {
            ...baseCfg.gateway!,
            security: { rejectCrossSiteWebSocketRequests: true },
          },
        }) as unknown as OpenClawConfig,
    });
    const result = await new Promise<boolean>((resolve) => {
      verifyClient(
        makeReq({
          remoteAddress: "192.0.2.10",
          origin: "null",
          headers: { host: "gateway.internal", "sec-fetch-site": "cross-site" },
        }),
        (ok: boolean) => resolve(ok),
      );
    });
    expect(result).toBe(false);
  });

  it("passes non-browser clients that send no Origin header", async () => {
    expect(
      await verifyOk({ remoteAddress: "192.0.2.10", headers: { host: "gateway.internal" } }),
    ).toBe(true);
  });
});

describe("validateSensitiveHeaders duplicate detection via rawHeaders", () => {
  // ClawSweeper: Node's normalized req.headers discards duplicate Host lines,
  // so strict validation built on it would silently miss the duplicates. Read
  // req.rawHeaders instead so duplicate Host and other sensitive headers are
  // actually caught.
  it("rejects duplicate Host lines visible only in rawHeaders", () => {
    const result = validateSensitiveHeaders([
      "Host",
      "gateway.internal",
      "Host",
      "evil.example.com",
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects comma-chained X-Forwarded-For in a single raw header line", () => {
    const result = validateSensitiveHeaders(["X-Forwarded-For", "1.1.1.1, 2.2.2.2"]);
    expect(result.ok).toBe(false);
  });

  it("passes a clean single-valued sensitive header", () => {
    const result = validateSensitiveHeaders(["Host", "gateway.internal"]);
    expect(result.ok).toBe(true);
  });
});

describe("validateForwardedHeaderConsistency IPv6 handling", () => {
  // Regression guard for ClawSweeper finding: split(":")[0] truncated IPv6 literals,
  // so distinct IPv6 forwarded values could appear consistent or vice versa.
  it("detects contradiction between X-Forwarded-For and Forwarded for IPv6 peers", () => {
    const result = validateForwardedHeaderConsistency(
      {
        "x-forwarded-for": "2001:db8::1",
        forwarded: 'for="[2001:db8::dead:beef]"',
      },
      ["127.0.0.1/32"],
    );
    expect(result.ok).toBe(false);
  });

  it("accepts matching IPv6 values across header forms (with and without brackets/port)", () => {
    const result = validateForwardedHeaderConsistency(
      {
        "x-forwarded-for": "[2001:db8::1]:1234",
        forwarded: 'for="[2001:db8::1]"',
      },
      ["127.0.0.1/32"],
    );
    expect(result.ok).toBe(true);
  });
});
