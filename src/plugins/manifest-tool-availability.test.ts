import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import {
  hasManifestToolAvailability,
  manifestConfigSignalPasses,
} from "./manifest-tool-availability.js";

function createPlugin(overrides: Partial<PluginManifestRecord> = {}): PluginManifestRecord {
  return {
    id: "fuzzplugin",
    origin: "bundled",
    rootDir: "/plugins/fuzzplugin",
    source: "/plugins/fuzzplugin/index.js",
    manifestPath: "/plugins/fuzzplugin/openclaw.plugin.json",
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    contracts: {},
    ...overrides,
  };
}

describe("manifest tool availability", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed on unreadable tool auth aliases without crashing availability checks", () => {
    const plugin = createPlugin({
      toolMetadata: {
        fuzz_move_delta: {
          aliases: new Proxy([], {
            get(target, key, receiver) {
              if (key === "length") {
                throw new Error("fuzzplugin tool alias length failed");
              }
              return Reflect.get(target, key, receiver);
            },
          }) as never,
        },
      },
    });

    expect(
      hasManifestToolAvailability({
        plugin,
        toolNames: ["fuzz_move_delta"],
        env: process.env,
      }),
    ).toBe(false);
  });

  it("fails closed when tool metadata entries are unreadable", () => {
    const plugin = createPlugin({
      toolMetadata: new Proxy(
        {},
        {
          get(target, key, receiver) {
            if (key === "fuzz_move_delta") {
              throw new Error("fuzzplugin tool metadata read failed");
            }
            return Reflect.get(target, key, receiver);
          },
        },
      ) as never,
    });

    expect(
      hasManifestToolAvailability({
        plugin,
        toolNames: ["fuzz_move_delta"],
        env: process.env,
      }),
    ).toBe(false);
  });

  it("falls back to provider auth env vars when setup providers are unreadable", () => {
    const plugin = createPlugin({
      toolMetadata: {
        fuzz_move_delta: {
          aliases: ["mockplugin"],
        },
      },
      setup: {
        providers: new Proxy([], {
          get(target, key, receiver) {
            if (key === "find") {
              throw new Error("fuzzplugin setup providers find failed");
            }
            return Reflect.get(target, key, receiver);
          },
        }) as never,
      },
      providerAuthEnvVars: {
        mockplugin: ["MOCKPLUGIN_API_KEY"],
      },
    });
    vi.stubEnv("MOCKPLUGIN_API_KEY", "mock-key");

    expect(
      hasManifestToolAvailability({
        plugin,
        toolNames: ["fuzz_move_delta"],
        env: process.env,
      }),
    ).toBe(true);
  });

  it("treats unreadable config signal objects as unavailable", () => {
    const config = {
      plugins: {
        entries: {
          fuzzplugin: {
            config: new Proxy(
              {},
              {
                ownKeys() {
                  throw new Error("mockplugin config keys failed");
                },
              },
            ),
          },
        },
      },
    } as OpenClawConfig;

    expect(
      manifestConfigSignalPasses({
        config,
        env: process.env,
        signal: {
          rootPath: "plugins.entries.fuzzplugin.config",
          required: ["apiKey"],
        },
      }),
    ).toBe(false);
  });

  it("treats unreadable required config signal lists as unavailable", () => {
    expect(
      manifestConfigSignalPasses({
        config: {
          plugins: {
            entries: {
              fuzzplugin: {
                config: { apiKey: "mock-key" },
              },
            },
          },
        },
        env: process.env,
        signal: {
          rootPath: "plugins.entries.fuzzplugin.config",
          required: new Proxy([], {
            get(target, key, receiver) {
              if (key === "length") {
                throw new Error("mockplugin required paths length failed");
              }
              return Reflect.get(target, key, receiver);
            },
          }) as never,
        },
      }),
    ).toBe(false);
  });
});
