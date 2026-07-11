import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn } from "../../llm.js";
import { generateBranchSummary } from "./branch-summarization.js";
import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  generateSummary,
  generateSummaryWithUsage,
} from "./compaction.js";

const USAGE_BUDGET_RECORDED_COST_METADATA_KEY = "usageBudgetRecordedCost";

describe("generateSummary thinking options", () => {
  it("maps explicit Fable off to low effort for compaction", async () => {
    const model: Model = {
      id: "production-fable",
      name: "Production Fable",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      params: { canonicalModelId: "claude-fable-5" },
    };
    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    const streamFn = vi.fn<StreamFn>((_model, _context, options) => {
      expect(options?.reasoning).toBe("low");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: summaryMessage });
      stream.end();
      return stream;
    });

    const result = await generateSummary(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      1000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "off",
      streamFn,
    );

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it("returns usage for successful compaction summaries", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    };
    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 12,
        output: 3,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: 17,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    const streamFn = vi.fn<StreamFn>(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: summaryMessage });
      stream.end();
      return stream;
    });

    const result = await compact(
      {
        firstKeptEntryId: "keep-1",
        messagesToSummarize: [{ role: "user", content: "hello", timestamp: 1 }],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 100,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: DEFAULT_COMPACTION_SETTINGS,
      },
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );

    expect(result).toMatchObject({
      ok: true,
      value: { summary: "summary", usage: summaryMessage.usage },
    });
    if (!result.ok) {
      throw new Error("expected compaction success");
    }
    expect(result.value.usageBudgetOperationId).toMatch(/^compaction:/);
    expect(streamFn.mock.calls[0]?.[2]?.usageBudgetOperationId).toBe(
      result.value.usageBudgetOperationId,
    );
  });

  it("preserves recorded cost metadata when merging split compaction usage", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    };
    const priorityMetadata = {
      schemaVersion: 1,
      kind: "estimated-model-call-cost",
      costMultiplier: 2,
    };
    const flexMetadata = {
      schemaVersion: 1,
      kind: "estimated-model-call-cost",
      costMultiplier: 0.5,
    };
    const usage = (
      tokens: { input: number; output: number; total: number },
      metadata?: typeof priorityMetadata,
    ) =>
      ({
        input: tokens.input,
        output: tokens.output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens.input + tokens.output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens.total },
        ...(metadata ? { [USAGE_BUDGET_RECORDED_COST_METADATA_KEY]: metadata } : {}),
      }) as AssistantMessage["usage"];
    const cases = [
      {
        turnUsage: usage({ input: 20, output: 5, total: 0.025 }, priorityMetadata),
        expectedCostMultiplier: 2,
      },
      {
        turnUsage: usage({ input: 20, output: 5, total: 0.025 }),
        expectedCostMultiplier: 1,
      },
      {
        turnUsage: usage({ input: 20, output: 5, total: 0.025 }, flexMetadata),
        expectedCostMultiplier: 1,
      },
    ];

    for (const testCase of cases) {
      const historyUsage = usage({ input: 10, output: 2, total: 0.012 }, priorityMetadata);
      const historyMessage: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "history summary" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: historyUsage,
        stopReason: "stop",
        timestamp: 1,
      };
      const turnMessage: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "turn summary" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: testCase.turnUsage,
        stopReason: "stop",
        timestamp: 2,
      };
      const streamFn = vi.fn<StreamFn>(() => {
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: streamFn.mock.calls.length === 1 ? historyMessage : turnMessage,
        });
        stream.end();
        return stream;
      });

      const result = await compact(
        {
          firstKeptEntryId: "keep-1",
          messagesToSummarize: [{ role: "user", content: "old history", timestamp: 1 }],
          turnPrefixMessages: [{ role: "user", content: "split prefix", timestamp: 2 }],
          isSplitTurn: true,
          tokensBefore: 100,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          settings: DEFAULT_COMPACTION_SETTINGS,
        },
        model,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        streamFn,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected compaction success");
      }
      expect(result.value.usage?.totalTokens).toBe(37);
      expect(result.value.usage?.cost.total).toBeCloseTo(0.037, 8);
      expect(
        (result.value.usage as unknown as Record<string, unknown>)[
          USAGE_BUDGET_RECORDED_COST_METADATA_KEY
        ],
      ).toStrictEqual({
        schemaVersion: 1,
        kind: "estimated-model-call-cost",
        costMultiplier: testCase.expectedCostMultiplier,
      });
    }
  });

  it("preserves unpriceable cost metadata when merging split compaction usage", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    };
    const unpriceableMetadata = {
      schemaVersion: 1,
      kind: "unpriceable-model-call-cost",
      reason: "capacity-billed-service-tier",
    };
    const recordedMetadata = {
      schemaVersion: 1,
      kind: "estimated-model-call-cost",
      costMultiplier: 2,
    };
    const usage = (
      tokens: { input: number; output: number; total: number },
      metadata: typeof unpriceableMetadata | typeof recordedMetadata,
    ) =>
      ({
        input: tokens.input,
        output: tokens.output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens.input + tokens.output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens.total },
        [USAGE_BUDGET_RECORDED_COST_METADATA_KEY]: metadata,
      }) as AssistantMessage["usage"];
    const historyMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "history summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: usage({ input: 10, output: 2, total: 0.012 }, unpriceableMetadata),
      stopReason: "stop",
      timestamp: 1,
    };
    const turnMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "turn summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: usage({ input: 20, output: 5, total: 0.025 }, recordedMetadata),
      stopReason: "stop",
      timestamp: 2,
    };
    const streamFn = vi.fn<StreamFn>(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: streamFn.mock.calls.length === 1 ? historyMessage : turnMessage,
      });
      stream.end();
      return stream;
    });

    const result = await compact(
      {
        firstKeptEntryId: "keep-1",
        messagesToSummarize: [{ role: "user", content: "old history", timestamp: 1 }],
        turnPrefixMessages: [{ role: "user", content: "split prefix", timestamp: 2 }],
        isSplitTurn: true,
        tokensBefore: 100,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: DEFAULT_COMPACTION_SETTINGS,
      },
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected compaction success");
    }
    expect(result.value.usage?.totalTokens).toBe(37);
    expect(result.value.usage?.cost.total).toBeCloseTo(0.037, 8);
    expect(
      (result.value.usage as unknown as Record<string, unknown>)[
        USAGE_BUDGET_RECORDED_COST_METADATA_KEY
      ],
    ).toStrictEqual(unpriceableMetadata);
  });

  it("preserves provider-billed zero cost metadata when merging split compaction usage", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    };
    const providerBilledMetadata = {
      schemaVersion: 1,
      kind: "provider-billed-model-call-cost",
      costMultiplier: 1,
    };
    const usage = (tokens: { input: number; output: number }) =>
      ({
        input: tokens.input,
        output: tokens.output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens.input + tokens.output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        [USAGE_BUDGET_RECORDED_COST_METADATA_KEY]: providerBilledMetadata,
      }) as AssistantMessage["usage"];
    const historyMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "history summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: usage({ input: 10, output: 2 }),
      stopReason: "stop",
      timestamp: 1,
    };
    const turnMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "turn summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: usage({ input: 20, output: 5 }),
      stopReason: "stop",
      timestamp: 2,
    };
    const streamFn = vi.fn<StreamFn>(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: streamFn.mock.calls.length === 1 ? historyMessage : turnMessage,
      });
      stream.end();
      return stream;
    });

    const result = await compact(
      {
        firstKeptEntryId: "keep-1",
        messagesToSummarize: [{ role: "user", content: "old history", timestamp: 1 }],
        turnPrefixMessages: [{ role: "user", content: "split prefix", timestamp: 2 }],
        isSplitTurn: true,
        tokensBefore: 100,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: DEFAULT_COMPACTION_SETTINGS,
      },
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected compaction success");
    }
    expect(result.value.usage?.totalTokens).toBe(37);
    expect(result.value.usage?.cost.total).toBe(0);
    expect(
      (result.value.usage as unknown as Record<string, unknown>)[
        USAGE_BUDGET_RECORDED_COST_METADATA_KEY
      ],
    ).toStrictEqual(providerBilledMetadata);
  });

  it("zeros split compaction aggregate cost when one part lacks spend evidence", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    };
    const metadata = {
      schemaVersion: 1,
      kind: "estimated-model-call-cost",
      costMultiplier: 2,
    };
    const historyMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "history summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.012 },
        [USAGE_BUDGET_RECORDED_COST_METADATA_KEY]: metadata,
      } as NonNullable<AssistantMessage["usage"]>,
      stopReason: "stop",
      timestamp: 1,
    };
    const turnMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "turn summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 20,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 25,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    };
    const streamFn = vi.fn<StreamFn>(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: streamFn.mock.calls.length === 1 ? historyMessage : turnMessage,
      });
      stream.end();
      return stream;
    });

    const result = await compact(
      {
        firstKeptEntryId: "keep-1",
        messagesToSummarize: [{ role: "user", content: "old history", timestamp: 1 }],
        turnPrefixMessages: [{ role: "user", content: "split prefix", timestamp: 2 }],
        isSplitTurn: true,
        tokensBefore: 100,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: DEFAULT_COMPACTION_SETTINGS,
      },
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected compaction success");
    }
    expect(result.value.usage?.totalTokens).toBe(37);
    expect(result.value.usage?.cost).toStrictEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
    expect(
      (result.value.usage as unknown as Record<string, unknown>)[
        USAGE_BUDGET_RECORDED_COST_METADATA_KEY
      ],
    ).toBeUndefined();
  });

  it("disables provider retries for budgeted compaction summaries", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    };
    const usage = {
      input: 12,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 17,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
    };
    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "stop",
      timestamp: 1,
    };
    const onProviderDispatch = vi.fn();
    const streamFn = vi.fn<StreamFn>((_model, _context, options) => {
      expect(options?.maxRetries).toBe(0);
      expect(options?.usageBudgetOperationId).toBe("budget-op");
      options?.onProviderDispatch?.();
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: summaryMessage });
      stream.end();
      return stream;
    });

    const result = await generateSummaryWithUsage(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      1000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
      undefined,
      "budget-op",
      onProviderDispatch,
      true,
    );

    expect(result).toEqual({
      ok: true,
      value: { summary: "summary", usage },
    });
    expect(onProviderDispatch).toHaveBeenCalledOnce();
  });

  it("returns branch summary operation ids used by the stream wrapper", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    };
    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "branch summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 12,
        output: 3,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: 17,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    const streamFn = vi.fn<StreamFn>(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: summaryMessage });
      stream.end();
      return stream;
    });

    const result = await generateBranchSummary(
      [
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: { role: "user", content: "hello", timestamp: 1 },
        },
      ],
      {
        model,
        apiKey: "test-key",
        signal: new AbortController().signal,
        streamFn,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      value: { summary: expect.stringContaining("branch summary"), usage: summaryMessage.usage },
    });
    if (!result.ok) {
      throw new Error("expected branch summary success");
    }
    expect(result.value.usageBudgetOperationId).toMatch(/^branch-summary:/);
    expect(streamFn.mock.calls[0]?.[2]?.usageBudgetOperationId).toBe(
      result.value.usageBudgetOperationId,
    );
  });

  it("returns branch summary operation ids when provider usage arrives on failure", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    };
    const usage = {
      input: 12,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 17,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
    };
    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "error",
      errorMessage: "provider failed",
      timestamp: 1,
    };
    const streamFn = vi.fn<StreamFn>(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error: summaryMessage });
      stream.end(summaryMessage);
      return stream;
    });

    const result = await generateBranchSummary(
      [
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: { role: "user", content: "hello", timestamp: 1 },
        },
      ],
      {
        model,
        apiKey: "test-key",
        signal: new AbortController().signal,
        streamFn,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "summarization_failed",
        usage,
      },
    });
    if (result.ok) {
      throw new Error("expected branch summary failure");
    }
    expect(result.error.usageBudgetOperationId).toMatch(/^branch-summary:/);
    expect(streamFn.mock.calls[0]?.[2]?.usageBudgetOperationId).toBe(
      result.error.usageBudgetOperationId,
    );
  });

  it("keeps successful split-turn usage on the compaction error when the paired summary fails", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    };
    const usage = {
      input: 12,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 17,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
    };
    const historyMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "history summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "stop",
      timestamp: 1,
    };
    const failedTurnMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "turn prefix failed",
      timestamp: 2,
    };
    const streamFn = vi.fn<StreamFn>(() => {
      const stream = createAssistantMessageEventStream();
      const message = streamFn.mock.calls.length === 1 ? historyMessage : failedTurnMessage;
      if (message.stopReason === "stop") {
        stream.push({ type: "done", reason: "stop", message });
      } else {
        stream.push({ type: "error", reason: "error", error: message });
      }
      stream.end(message);
      return stream;
    });

    const result = await compact(
      {
        firstKeptEntryId: "keep-1",
        messagesToSummarize: [{ role: "user", content: "old history", timestamp: 1 }],
        turnPrefixMessages: [{ role: "user", content: "split prefix", timestamp: 2 }],
        isSplitTurn: true,
        tokensBefore: 100,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: DEFAULT_COMPACTION_SETTINGS,
      },
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "summarization_failed",
        usage,
      },
    });
    if (result.ok) {
      throw new Error("expected compaction failure");
    }
    expect(result.error.usageBudgetOperationId).toMatch(/^compaction:/);
    const operationIds = streamFn.mock.calls.map((call) => call[2]?.usageBudgetOperationId);
    expect(new Set(operationIds).size).toBe(1);
    expect(operationIds[0]).toBe(result.error.usageBudgetOperationId);
  });
});
