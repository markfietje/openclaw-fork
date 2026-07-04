import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  canRunPassiveRoomObservationWithEmbeddedHarness,
  canRunPassiveRoomObservationWithResolvedModel,
} from "./passive-runtime.js";

describe("canRunPassiveRoomObservationWithEmbeddedHarness", () => {
  it("allows only the core OpenAI embedded runtime", () => {
    expect(
      canRunPassiveRoomObservationWithEmbeddedHarness({ provider: "openai", modelId: "gpt-5.5" }),
    ).toBe(true);
    expect(
      canRunPassiveRoomObservationWithEmbeddedHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        runtimeOverride: "openclaw",
      }),
    ).toBe(true);
  });

  it("rejects native, CLI-like, and non-core providers", () => {
    for (const runtimeOverride of ["codex", "copilot"]) {
      expect(
        canRunPassiveRoomObservationWithEmbeddedHarness({
          provider: "openai",
          modelId: "gpt-5.5",
          runtimeOverride,
        }),
      ).toBe(false);
    }
    expect(
      canRunPassiveRoomObservationWithEmbeddedHarness({
        provider: "anthropic",
        modelId: "claude-opus",
        runtimeOverride: "openclaw",
      }),
    ).toBe(false);
  });

  it("rejects configured native harness policies", () => {
    for (const runtime of ["codex", "copilot"]) {
      expect(
        canRunPassiveRoomObservationWithEmbeddedHarness({
          config: {
            agents: {
              defaults: {
                models: {
                  "openai/gpt-5.5": { agentRuntime: { id: runtime } },
                },
              },
            },
          } as OpenClawConfig,
          provider: "openai",
          modelId: "gpt-5.5",
        }),
      ).toBe(false);
    }
  });

  it("rejects configured OpenAI model and transport overrides before harness startup", () => {
    for (const openai of [
      { baseUrl: "https://proxy.example/v1" },
      { headers: { "X-Proxy-Key": "secret" } },
      { models: [{ id: "custom" }] },
      { auth: "aws-sdk" },
      { request: { allowPrivateNetwork: true } },
    ]) {
      expect(
        canRunPassiveRoomObservationWithEmbeddedHarness({
          config: { models: { providers: { openai } } } as unknown as OpenClawConfig,
          provider: "openai",
          modelId: "gpt-5.5",
        }),
      ).toBe(false);
    }
  });
});

describe("canRunPassiveRoomObservationWithResolvedModel", () => {
  const model = {
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  } as const;

  it("allows only an unmodified core OpenAI transport", () => {
    expect(canRunPassiveRoomObservationWithResolvedModel({ provider: "openai", model })).toBe(true);
    expect(
      canRunPassiveRoomObservationWithResolvedModel({
        provider: "openai",
        model: { ...model, baseUrl: "https://proxy.example/v1" },
      }),
    ).toBe(false);
    expect(
      canRunPassiveRoomObservationWithResolvedModel({
        provider: "openai",
        model: { ...model, headers: { "X-Proxy": "enabled" } },
      }),
    ).toBe(false);
    expect(
      canRunPassiveRoomObservationWithResolvedModel({
        provider: "openai",
        model: { ...model, api: "openai-chatgpt-responses" },
      }),
    ).toBe(false);
  });
});
