import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { classifySecretResolutionErrorDegradations } from "./runtime-degradation-classifier.js";
import { associateSecretResolutionErrorOwners } from "./runtime-degraded-state.js";

const mocks = vi.hoisted(() => ({
  activeSnapshot: null as {
    sourceConfig: OpenClawConfig;
    config: OpenClawConfig;
    degradedOwners?: Array<{ ownerKind: string; ownerId: string }>;
  } | null,
}));

vi.mock("./runtime-state.js", () => ({
  getActiveSecretsRuntimeSnapshot: () => mocks.activeSnapshot,
}));

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });

beforeEach(() => {
  mocks.activeSnapshot = null;
});

describe("classifySecretResolutionErrorDegradations", () => {
  it("marks a newly configured failed owner cold", () => {
    mocks.activeSnapshot = { sourceConfig: {}, config: {}, degradedOwners: [] };
    const error = new Error("private resolution details");
    associateSecretResolutionErrorOwners(error, [
      {
        ownerKind: "route",
        ownerId: "webhooks/zapier",
        state: "unavailable",
        paths: ["plugins.entries.webhooks.config.routes.zapier.secret"],
        refKeys: ["env:default:FIXTURE_ROUTE"],
        reason: "secret reference was not found",
        failureMatched: true,
      },
    ]);

    expect(
      classifySecretResolutionErrorDegradations({
        error,
      }),
    ).toEqual([
      {
        kind: "route",
        id: "webhooks/zapier",
        reason: "secret reference was not found",
        state: "cold",
        retryHint: "openclaw secrets reload",
        paths: ["plugins.entries.webhooks.config.routes.zapier.secret"],
      },
    ]);
  });

  it("lists every owner rolled back by the atomic reload", () => {
    const refA = envRef("FIXTURE_PROVIDER_A");
    const refB = envRef("FIXTURE_PROVIDER_B");
    const oldRef = envRef("FIXTURE_TTS_OLD");
    mocks.activeSnapshot = {
      sourceConfig: {
        models: {
          providers: {
            openai: {
              apiKey: refA,
              baseUrl: "https://example.com",
              models: [],
            },
            anthropic: {
              apiKey: refB,
              baseUrl: "https://example.com",
              models: [],
            },
          },
        },
        messages: {
          tts: { providers: { elevenlabs: { apiKey: oldRef } } },
        },
      },
      config: {
        models: {
          providers: {
            openai: { apiKey: "test-api-key", baseUrl: "https://example.com", models: [] },
            anthropic: {
              apiKey: "test-api-key",
              baseUrl: "https://example.com",
              models: [],
            },
          },
        },
        messages: { tts: { providers: { elevenlabs: { apiKey: "test-api-key" } } } },
      },
      degradedOwners: [],
    };
    const error = new Error("private resolution details");
    associateSecretResolutionErrorOwners(error, [
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        paths: ["models.providers.openai.apiKey"],
        refKeys: ["env:default:FIXTURE_PROVIDER_A"],
        reason: "secret provider failed",
        failureMatched: true,
      },
      {
        ownerKind: "capability",
        ownerId: "tts",
        state: "unavailable",
        paths: ["messages.tts.providers.elevenlabs.apiKey"],
        refKeys: ["env:default:FIXTURE_TTS_NEW"],
        reason: "secret reload was not activated",
        failureMatched: false,
      },
      {
        ownerKind: "provider",
        ownerId: "anthropic",
        state: "unavailable",
        paths: ["models.providers.anthropic.apiKey"],
        refKeys: ["env:default:FIXTURE_PROVIDER_B"],
        reason: "secret reload was not activated",
        failureMatched: false,
      },
    ]);

    expect(classifySecretResolutionErrorDegradations({ error })).toEqual([
      {
        kind: "provider",
        id: "openai",
        reason: "secret provider failed",
        state: "stale",
        retryHint: "openclaw secrets reload",
        paths: ["models.providers.openai.apiKey"],
      },
      {
        kind: "capability",
        id: "tts",
        reason: "secret reload was not activated",
        state: "stale",
        retryHint: "openclaw secrets reload",
        paths: ["messages.tts.providers.elevenlabs.apiKey"],
      },
      {
        kind: "provider",
        id: "anthropic",
        reason: "secret reload was not activated",
        state: "stale",
        retryHint: "openclaw secrets reload",
        paths: ["models.providers.anthropic.apiKey"],
      },
    ]);
  });

  it("uses a generic runtime owner when typed attribution is unavailable", () => {
    mocks.activeSnapshot = { sourceConfig: {}, config: {}, degradedOwners: [] };

    expect(
      classifySecretResolutionErrorDegradations({
        error: new Error("private"),
      }),
    ).toEqual([
      {
        kind: "unknown",
        id: "runtime",
        reason: "secret reload failed",
        state: "stale",
        retryHint: "openclaw secrets reload",
        paths: [],
      },
    ]);
  });
});
