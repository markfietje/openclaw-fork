// Anthropic tests cover stream wrappers plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  markProviderDispatchCostMultiplierResolverStreamFn,
  markProviderDispatchReservationCostMultiplierResolverStreamFn,
  resolveProviderDispatchCostMultiplierForStreamFn,
  resolveProviderDispatchReservationCostMultiplierForStreamFn,
  USAGE_BUDGET_RECORDED_COST_METADATA_KEY,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  createAnthropicBetaHeadersWrapper,
  createAnthropicFastModeWrapper,
  createAnthropicServiceTierWrapper,
  createAnthropicThinkingPrefillWrapper,
  resolveAnthropicBetas,
  resolveAnthropicFastMode,
  wrapAnthropicProviderStream,
} from "./stream-wrappers.js";

const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_BETA_HEADER =
  "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14";
const OAUTH_BETA_HEADER = `claude-code-20250219,${OAUTH_BETA},${DEFAULT_BETA_HEADER}`;
const anthropicModel = {
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: undefined,
  id: "claude-sonnet-4-6",
} as never;

function runWrapper(apiKey: string | undefined): Record<string, string> | undefined {
  const captured: { headers?: Record<string, string> } = {};
  const base: StreamFn = (_model, _context, options) => {
    captured.headers = options?.headers;
    return {} as never;
  };
  const wrapper = createAnthropicBetaHeadersWrapper(base, [CONTEXT_1M_BETA]);
  void wrapper(
    { provider: "anthropic", id: "claude-opus-4-6" } as never,
    {} as never,
    { apiKey } as never,
  );
  return captured.headers;
}

function createPayloadCapturingBaseStream(captured: {
  headers?: Record<string, string>;
  payload?: Record<string, unknown>;
}): StreamFn {
  return (model, _context, options) => {
    captured.headers = options?.headers;
    const payload = {} as Record<string, unknown>;
    options?.onPayload?.(payload as never, model as never);
    captured.payload = payload;
    return {} as never;
  };
}

function runComposedAnthropicProviderStream(apiKey: string) {
  const captured: { headers?: Record<string, string>; payload?: Record<string, unknown> } = {};
  const wrapped = wrapAnthropicProviderStream({
    streamFn: createPayloadCapturingBaseStream(captured),
    modelId: "claude-sonnet-4-6",
    extraParams: { context1m: true, serviceTier: "auto" },
  } as never);

  void wrapped?.(
    { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
    {} as never,
    { apiKey } as never,
  );
  return captured;
}

function runPayloadWrapper(
  params: {
    apiKey?: string;
    provider?: string;
    api?: string;
    baseUrl?: string;
  },
  createWrapper: (base: StreamFn) => StreamFn,
): Record<string, unknown> | undefined {
  const captured: { payload?: Record<string, unknown> } = {};
  const wrapper = createWrapper(createPayloadCapturingBaseStream(captured));
  void wrapper(
    {
      provider: params.provider ?? "anthropic",
      api: params.api ?? "anthropic-messages",
      baseUrl: params.baseUrl,
      id: "claude-sonnet-4-6",
    } as never,
    {} as never,
    { apiKey: params.apiKey } as never,
  );
  return captured.payload;
}

function createUsageStream(usage: Record<string, unknown>): ReturnType<StreamFn> {
  const message = {
    role: "assistant",
    content: [],
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage,
    stopReason: "stop",
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: "stop", message } as never;
    },
    async result() {
      return message as never;
    },
  };
}

describe("anthropic stream wrappers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips legacy context-1m betas for Claude CLI or legacy token auth", () => {
    const warn = vi.spyOn(testing.log, "warn").mockImplementation(() => undefined);
    const headers = runWrapper("sk-ant-oat01-123");
    expect(headers?.["anthropic-beta"]).toBeDefined();
    expect(headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
    expect(warn).not.toHaveBeenCalled();
  });

  it("strips legacy context-1m betas for API key auth", () => {
    const warn = vi.spyOn(testing.log, "warn").mockImplementation(() => undefined);
    const headers = runWrapper("sk-ant-api-123");
    expect(headers?.["anthropic-beta"]).toBeDefined();
    expect(headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips service_tier for OAuth token in composed stream chain", () => {
    const captured = runComposedAnthropicProviderStream("sk-ant-oat01-oauth-token");
    expect(captured.headers?.["anthropic-beta"]).toBe(OAUTH_BETA_HEADER);
    expect(captured.payload?.service_tier).toBeUndefined();
  });

  it("composes the anthropic provider stream chain from extra params", () => {
    const captured = runComposedAnthropicProviderStream("sk-ant-api-123");
    expect(captured.headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
    expect(captured.payload).toMatchObject({ service_tier: "auto" });
  });

  it("does not emit the legacy context-1m beta from context1m or explicit config", () => {
    expect(
      resolveAnthropicBetas(
        { context1m: true, anthropicBeta: [CONTEXT_1M_BETA, "files-api-2025-04-14"] },
        "claude-sonnet-4-6",
      ),
    ).toEqual(["files-api-2025-04-14"]);
  });

  it("strips legacy context-1m beta from comma-separated string config", () => {
    expect(
      resolveAnthropicBetas(
        { anthropicBeta: `${CONTEXT_1M_BETA},files-api-2025-04-14` },
        "claude-sonnet-4-6",
      ),
    ).toEqual(["files-api-2025-04-14"]);
  });

  it("preserves OAuth-required betas when context1m is the only configured beta trigger", () => {
    const captured: { headers?: Record<string, string> } = {};
    const wrapped = wrapAnthropicProviderStream({
      streamFn: createPayloadCapturingBaseStream(captured),
      modelId: "claude-sonnet-4-6",
      extraParams: { context1m: true },
    } as never);

    void wrapped?.(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-oat01-oauth-token" } as never,
    );

    expect(captured.headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(captured.headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
  });

  it("preserves OAuth-required betas when legacy context-1m is the only configured beta", () => {
    const captured: { headers?: Record<string, string> } = {};
    const wrapped = wrapAnthropicProviderStream({
      streamFn: createPayloadCapturingBaseStream(captured),
      modelId: "claude-sonnet-4-6",
      extraParams: { anthropicBeta: [CONTEXT_1M_BETA] },
    } as never);

    void wrapped?.(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-oat01-oauth-token" } as never,
    );

    expect(captured.headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(captured.headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
  });

  it("ignores unresolved auto fast mode at the provider boundary", () => {
    expect(resolveAnthropicFastMode({ fastMode: "auto" })).toBeUndefined();
  });
});

describe("createAnthropicThinkingPrefillWrapper", () => {
  function runThinkingPrefillWrapper(payload: Record<string, unknown>): Record<string, unknown> {
    const wrapper = createAnthropicThinkingPrefillWrapper(((_model, _context, options) => {
      options?.onPayload?.(payload as never, {} as never);
      return {} as never;
    }) as StreamFn);
    void wrapper({ provider: "anthropic", api: "anthropic-messages" } as never, {} as never, {});
    return payload;
  }

  it("removes trailing assistant prefill when extended thinking is enabled", () => {
    const warn = vi.spyOn(testing.log, "warn").mockImplementation(() => undefined);
    const payload = runThinkingPrefillWrapper({
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    });

    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps assistant prefill when thinking is disabled", () => {
    const payload = runThinkingPrefillWrapper({
      thinking: { type: "disabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    });

    expect(payload.messages).toHaveLength(2);
  });

  it("keeps trailing assistant tool use turns", () => {
    const payload = runThinkingPrefillWrapper({
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Read a file." },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read" }] },
      ],
    });

    expect(payload.messages).toHaveLength(2);
  });
});

type ServiceTierWrapperParams = {
  apiKey?: string;
  provider?: string;
  api?: string;
  enabled?: boolean;
  serviceTier?: "auto" | "standard_only";
};

const serviceTierWrapperCases: Array<{
  name: string;
  run: (params: ServiceTierWrapperParams) => Record<string, unknown> | undefined;
}> = [
  {
    name: "fast mode",
    run: (params) =>
      runPayloadWrapper(params, (base) =>
        createAnthropicFastModeWrapper(base, params.enabled ?? true),
      ),
  },
  {
    name: "explicit service tier",
    run: (params) =>
      runPayloadWrapper(params, (base) =>
        createAnthropicServiceTierWrapper(base, params.serviceTier ?? "auto"),
      ),
  },
];

describe("Anthropic service_tier payload wrappers", () => {
  it.each(serviceTierWrapperCases)("$name skips service_tier for OAuth token", ({ run }) => {
    const payload = run({ apiKey: "sk-ant-oat01-test-token" });
    expect(payload?.service_tier).toBeUndefined();
  });

  it.each(serviceTierWrapperCases)("$name injects service_tier for regular API keys", ({ run }) => {
    const payload = run({ apiKey: "sk-ant-api03-test-key" });
    expect(payload?.service_tier).toBe("auto");
  });

  it.each(serviceTierWrapperCases)(
    "$name does not inject service_tier for non-anthropic provider",
    ({ run }) => {
      const payload = run({
        apiKey: "sk-ant-api03-test-key",
        provider: "openai",
        api: "openai-completions",
      });
      expect(payload?.service_tier).toBeUndefined();
    },
  );

  it("fast mode injects service_tier=standard_only when disabled for API keys", () => {
    const payload = serviceTierWrapperCases[0].run({
      apiKey: "sk-ant-api03-test-key",
      enabled: false,
    });
    expect(payload?.service_tier).toBe("standard_only");
  });

  it("fast mode resolves dynamic service_tier for each stream call", () => {
    let enabled = true;
    const first = runPayloadWrapper({ apiKey: "sk-ant-api03-test-key" }, (base) =>
      createAnthropicFastModeWrapper(base, () => enabled),
    );
    enabled = false;
    const second = runPayloadWrapper({ apiKey: "sk-ant-api03-test-key" }, (base) =>
      createAnthropicFastModeWrapper(base, () => enabled),
    );
    expect(first?.service_tier).toBe("auto");
    expect(second?.service_tier).toBe("standard_only");
  });

  it("exposes dynamic fast-mode pricing before provider dispatch", () => {
    const base = vi.fn(() => ({}) as never) as StreamFn;
    const pricedBase = markProviderDispatchReservationCostMultiplierResolverStreamFn(
      markProviderDispatchCostMultiplierResolverStreamFn(base, () => 2),
      () => 3,
    );
    let enabled: boolean | undefined = true;
    const streamFn = createAnthropicFastModeWrapper(pricedBase, () => enabled);
    const resolveMultipliers = (apiKey: string) => ({
      cost: resolveProviderDispatchCostMultiplierForStreamFn({
        streamFn,
        model: anthropicModel,
        context: {} as never,
        options: { apiKey } as never,
      }),
      reservation: resolveProviderDispatchReservationCostMultiplierForStreamFn({
        streamFn,
        model: anthropicModel,
        context: {} as never,
        options: { apiKey } as never,
      }),
    });

    expect(resolveMultipliers("sk-ant-api03-test-key")).toEqual({
      cost: 1,
      reservation: undefined,
    });
    expect(base).not.toHaveBeenCalled();

    enabled = false;
    expect(resolveMultipliers("sk-ant-api03-test-key")).toEqual({ cost: 1, reservation: 1 });

    enabled = undefined;
    expect(resolveMultipliers("sk-ant-api03-test-key")).toEqual({ cost: 2, reservation: 3 });

    enabled = true;
    expect(resolveMultipliers("sk-ant-oat01-test-token")).toEqual({ cost: 2, reservation: 3 });
    expect(base).not.toHaveBeenCalled();
  });

  it("explicit service tier injects service_tier=standard_only for regular API keys", () => {
    const payload = serviceTierWrapperCases[1].run({
      apiKey: "sk-ant-api03-test-key",
      serviceTier: "standard_only",
    });
    expect(payload?.service_tier).toBe("standard_only");
  });

  it("treats auto service tier cost as unpriceable for usage budgets", async () => {
    const usage = {
      input: 100,
      output: 20,
      totalTokens: 120,
      cost: { input: 0.0001, output: 0.00004, cacheRead: 0, cacheWrite: 0, total: 0.00014 },
    };
    const streamFn = createAnthropicServiceTierWrapper(() => createUsageStream(usage), "auto");

    expect(
      resolveProviderDispatchReservationCostMultiplierForStreamFn({
        streamFn,
        model: anthropicModel,
        context: {} as never,
        options: { apiKey: "sk-ant-api03-test-key" } as never,
      }),
    ).toBeUndefined();

    const stream = await streamFn(
      anthropicModel,
      {} as never,
      { apiKey: "sk-ant-api03-test-key" } as never,
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(
      (usage as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toMatchObject({
      kind: "unpriceable-model-call-cost",
      reason: "capacity-billed-service-tier",
    });
  });

  it("marks standard_only service tier cost as a known multiplier", async () => {
    const usage = {
      input: 100,
      output: 20,
      totalTokens: 120,
      cost: { input: 0.0001, output: 0.00004, cacheRead: 0, cacheWrite: 0, total: 0.00014 },
    };
    const streamFn = createAnthropicServiceTierWrapper(
      () => createUsageStream(usage),
      "standard_only",
    );

    expect(
      resolveProviderDispatchCostMultiplierForStreamFn({
        streamFn,
        model: anthropicModel,
        context: {} as never,
        options: { apiKey: "sk-ant-api03-test-key" } as never,
      }),
    ).toBe(1);
    expect(
      resolveProviderDispatchReservationCostMultiplierForStreamFn({
        streamFn,
        model: anthropicModel,
        context: {} as never,
        options: { apiKey: "sk-ant-api03-test-key" } as never,
      }),
    ).toBe(1);

    const message = await (
      await streamFn(anthropicModel, {} as never, { apiKey: "sk-ant-api03-test-key" } as never)
    ).result();

    expect(
      (message.usage as unknown as Record<string, unknown>)[
        USAGE_BUDGET_RECORDED_COST_METADATA_KEY
      ],
    ).toMatchObject({
      kind: "model-call-cost-multiplier",
      costMultiplier: 1,
    });
  });
});
