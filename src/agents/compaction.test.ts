// Covers compaction token splitting and history pruning helpers.
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessage, ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withEnvOverride } from "../config/test-helpers.js";
import { USAGE_BUDGET_RECORDED_COST_METADATA_KEY } from "../shared/usage-budget-recorded-cost.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE,
  USAGE_BUDGET_OPERATION_ID_KEY,
} from "./compaction-usage-accounting.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import "./test-helpers/agent-session-token-mock.js";
import { AgentUsageBudgetError } from "./usage-budget.js";

let estimateMessagesTokens: typeof import("./compaction.js").estimateMessagesTokens;
let pruneHistoryForContextShare: typeof import("./compaction.js").pruneHistoryForContextShare;
let splitMessagesByTokenShare: typeof import("./compaction.js").splitMessagesByTokenShare;

beforeAll(async () => {
  vi.resetModules();
  ({ estimateMessagesTokens, pruneHistoryForContextShare, splitMessagesByTokenShare } =
    await import("./compaction.js"));
});

describe("compaction summary model-call accounting", () => {
  async function importCompactionWithSummaryGenerator(
    generateSummaryWithUsage: (
      ...args: unknown[]
    ) => Promise<{ summary: string; usage?: AssistantMessage["usage"] }>,
    providerDispatchObservable = true,
    dispatch?: {
      model?: { provider: string; id: string };
      costMultiplier?: number;
      reservationCostMultiplier?: number;
    },
  ): Promise<typeof import("./compaction.js")> {
    vi.resetModules();
    vi.doMock("./sessions/index.js", async () => {
      const actual =
        await vi.importActual<typeof import("./sessions/index.js")>("./sessions/index.js");
      return {
        ...actual,
        generateSummaryWithUsage: vi.fn(generateSummaryWithUsage),
      };
    });
    vi.doMock("./provider-dispatch-observable-stream.js", () => ({
      isModelProviderDispatchObservableStreamFn: vi.fn(() => providerDispatchObservable),
      resolveProviderDispatchModelForStreamFn: vi.fn(({ model }) => ({
        ...model,
        ...dispatch?.model,
      })),
      resolveProviderDispatchCostMultiplierForStreamFn: vi.fn(() => dispatch?.costMultiplier ?? 1),
      resolveProviderDispatchReservationCostMultiplierForStreamFn: vi.fn(
        () => dispatch?.reservationCostMultiplier ?? dispatch?.costMultiplier ?? 1,
      ),
    }));
    return await import("./compaction.js");
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("./sessions/index.js");
    vi.doUnmock("./provider-dispatch-observable-stream.js");
  });

  function summaryParams() {
    return {
      messages: [makeMessage(1, 20)],
      model: {
        id: "gpt-5.4",
        provider: "openai",
        api: "responses",
        maxTokens: 4096,
        contextWindow: 128_000,
      } as never,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 1024,
      maxChunkTokens: 4096,
      contextWindow: 128_000,
    };
  }

  it("propagates usage budget denials instead of producing fallback summaries", async () => {
    const error = new AgentUsageBudgetError("blocked", {
      agentId: "main",
      provider: "openai",
      model: "gpt-5.4",
      reason: "exceeded",
    });
    const { summarizeWithFallbackWithUsage } = await importCompactionWithSummaryGenerator(
      async () => {
        throw error;
      },
    );

    await expect(summarizeWithFallbackWithUsage(summaryParams())).rejects.toBe(error);
    vi.doUnmock("./sessions/index.js");
  });

  it("accumulates usage from failed retry attempts before success", async () => {
    const failedUsage = {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.012 },
    };
    const successUsage = {
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 25,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.025 },
    };
    let attempts = 0;
    const { summarizeWithFallbackWithUsage } = await importCompactionWithSummaryGenerator(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("transient"), { usage: failedUsage });
        }
        return { summary: "ok", usage: successUsage };
      },
    );

    const result = await summarizeWithFallbackWithUsage(summaryParams());

    expect(result.summary).toBe("ok");
    expect(result.usage?.totalTokens).toBe(37);
    expect(result.usage?.cost.total).toBeCloseTo(0.037, 8);
    vi.doUnmock("./sessions/index.js");
  });

  it("preserves recorded cost metadata when merging compaction usage", async () => {
    const { mergeCompactionSummaryUsage } = await import("./compaction.js");
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
    const left = usage({ input: 10, output: 2, total: 0.012 }, priorityMetadata);
    const cases = [
      {
        right: usage({ input: 20, output: 5, total: 0.025 }, priorityMetadata),
        expectedCostMultiplier: 2,
      },
      {
        right: usage({ input: 20, output: 5, total: 0.025 }),
        expectedCostMultiplier: 1,
      },
      {
        right: usage({ input: 20, output: 5, total: 0.025 }, flexMetadata),
        expectedCostMultiplier: 1,
      },
    ];

    for (const testCase of cases) {
      const result = mergeCompactionSummaryUsage(left, testCase.right);

      expect(result?.totalTokens).toBe(37);
      expect(result?.cost.total).toBeCloseTo(0.037, 8);
      expect(
        (result as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
      ).toStrictEqual({
        schemaVersion: 1,
        kind: "estimated-model-call-cost",
        costMultiplier: testCase.expectedCostMultiplier,
      });
    }
  });

  it("preserves unpriceable cost metadata when merging compaction usage", async () => {
    const { mergeCompactionSummaryUsage } = await import("./compaction.js");
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
    const left = {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.012 },
      [USAGE_BUDGET_RECORDED_COST_METADATA_KEY]: unpriceableMetadata,
    } as AssistantMessage["usage"];
    const right = {
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 25,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.025 },
      [USAGE_BUDGET_RECORDED_COST_METADATA_KEY]: recordedMetadata,
    } as AssistantMessage["usage"];

    const result = mergeCompactionSummaryUsage(left, right);

    expect(result?.totalTokens).toBe(37);
    expect(result?.cost.total).toBeCloseTo(0.037, 8);
    expect(
      (result as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toStrictEqual(unpriceableMetadata);
  });

  it("preserves provider-billed zero cost metadata when merging compaction usage", async () => {
    const { mergeCompactionSummaryUsage } = await import("./compaction.js");
    const providerBilledMetadata = {
      schemaVersion: 1,
      kind: "provider-billed-model-call-cost",
      costMultiplier: 1,
    };
    const left = {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      [USAGE_BUDGET_RECORDED_COST_METADATA_KEY]: providerBilledMetadata,
    } as AssistantMessage["usage"];
    const right = {
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 25,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      [USAGE_BUDGET_RECORDED_COST_METADATA_KEY]: providerBilledMetadata,
    } as AssistantMessage["usage"];

    const result = mergeCompactionSummaryUsage(left, right);

    expect(result?.totalTokens).toBe(37);
    expect(result?.cost.total).toBe(0);
    expect(
      (result as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toStrictEqual(providerBilledMetadata);
  });

  it("drops recorded cost metadata when a merged compaction part has no cost evidence", async () => {
    const { mergeCompactionSummaryUsage } = await import("./compaction.js");
    const metadata = {
      schemaVersion: 1,
      kind: "estimated-model-call-cost",
      costMultiplier: 2,
    };
    const left = {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.012 },
      [USAGE_BUDGET_RECORDED_COST_METADATA_KEY]: metadata,
    } as AssistantMessage["usage"];
    const right = {
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 25,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } as AssistantMessage["usage"];

    const result = mergeCompactionSummaryUsage(left, right);

    expect(
      (result as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toBeUndefined();
    expect(result?.cost).toStrictEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });

  it("persists budgeted summary usage accounting to the transcript", async () => {
    const callStartedAt = Date.UTC(2026, 6, 15, 23, 59, 59, 900);
    const callCompletedAt = Date.UTC(2026, 6, 16, 0, 0, 0, 100);
    const successUsage = {
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 25,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.025 },
    };
    const { summarizeWithFallbackWithUsage } = await importCompactionWithSummaryGenerator(
      async () => {
        vi.setSystemTime(callCompletedAt);
        return { summary: "ok", usage: successUsage };
      },
      true,
      {
        model: { provider: "openai", id: "gpt-5.4-priority" },
        costMultiplier: 2,
      },
    );

    await withTempDir({ prefix: "openclaw-compaction-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        vi.useFakeTimers();
        vi.setSystemTime(callStartedAt);
        const transcriptPath = path.join(stateDir, "agents", "main", "sessions", "summary.jsonl");
        const result = await summarizeWithFallbackWithUsage({
          ...summaryParams(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 10_000 },
                },
              },
            },
            models: {
              providers: {
                openai: {
                  baseUrl: "https://example.invalid",
                  models: [
                    {
                      id: "gpt-5.4-priority",
                      name: "gpt-5.4-priority",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 128_000,
                      maxTokens: 4096,
                    },
                  ],
                },
              },
            },
          },
          agentId: "main",
          transcriptPath,
        });

        expect(result.summary).toBe("ok");
        const transcript = await fs.readFile(transcriptPath, "utf8");
        expect(transcript).toContain(MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE);
        expect(transcript).toContain('"usageBudgetBridge":true');
        expect(transcript).toContain('"model":"gpt-5.4-priority"');
        expect(transcript).toContain('"total":25');
        expect(transcript).toContain('"total":0.00005');
        expect(transcript).toContain('"costMultiplier":2');
        const row = transcript
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((entry) => entry.type === "custom");
        expect(row?.timestamp).toBe(new Date(callStartedAt).toISOString());
      });
    });
    vi.doUnmock("./sessions/index.js");
  });

  it("uses dispatch reservation multipliers before admitting budgeted summaries", async () => {
    const generateSummaryWithUsage = vi.fn(async () => ({ summary: "should not dispatch" }));
    const { summarizeWithFallbackWithUsage } = await importCompactionWithSummaryGenerator(
      generateSummaryWithUsage,
      true,
      { reservationCostMultiplier: 2.5 },
    );

    await withTempDir({ prefix: "openclaw-compaction-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(
          summarizeWithFallbackWithUsage({
            ...summaryParams(),
            config: {
              agents: {
                defaults: {
                  usageBudget: {
                    daily: { usd: 0.002 },
                  },
                },
              },
              models: {
                providers: {
                  openai: {
                    baseUrl: "https://example.invalid",
                    models: [
                      {
                        id: "gpt-5.4",
                        name: "gpt-5.4",
                        reasoning: false,
                        input: ["text"],
                        cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 128_000,
                        maxTokens: 4096,
                      },
                    ],
                  },
                },
              },
            },
            agentId: "main",
            transcriptPath: path.join(stateDir, "agents", "main", "sessions", "summary.jsonl"),
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "spend" },
        });
      });
    });
    expect(generateSummaryWithUsage).not.toHaveBeenCalled();
    vi.doUnmock("./sessions/index.js");
  });

  it("does not persist unknown budget usage for pre-dispatch summary failures", async () => {
    const setupError = Object.assign(new Error("provider setup failed"), {
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const { summarizeWithFallbackWithUsage } = await importCompactionWithSummaryGenerator(
      async (...args: unknown[]) => {
        const onProviderDispatch = args.at(-1);
        expect(onProviderDispatch).toEqual(expect.any(Function));
        throw setupError;
      },
    );

    await withTempDir({ prefix: "openclaw-compaction-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const transcriptPath = path.join(stateDir, "agents", "main", "sessions", "summary.jsonl");
        const result = await summarizeWithFallbackWithUsage({
          ...summaryParams(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 10_000 },
                },
              },
            },
          },
          agentId: "main",
          transcriptPath,
        });

        expect(result.summary).toContain("Summary unavailable");
        await expect(fs.readFile(transcriptPath, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    });
    vi.doUnmock("./sessions/index.js");
  });

  it("allows repeated provider dispatch callbacks for unbudgeted summary retries", async () => {
    const generateSummaryWithUsage = vi.fn(async (...args: unknown[]) => {
      const onProviderDispatch = args[12];
      if (typeof onProviderDispatch !== "function") {
        throw new Error("missing provider dispatch callback");
      }
      onProviderDispatch();
      onProviderDispatch();
      return { summary: "ok" };
    });
    const { summarizeWithFallbackWithUsage } =
      await importCompactionWithSummaryGenerator(generateSummaryWithUsage);

    const result = await summarizeWithFallbackWithUsage({
      ...summaryParams(),
      config: {},
      agentId: "main",
    });

    expect(result.summary).toBe("ok");
    expect(generateSummaryWithUsage).toHaveBeenCalledOnce();
    vi.doUnmock("./sessions/index.js");
  });

  it("persists budget accounting when compaction fails after provider dispatch without usage", async () => {
    const operationId = "compaction-operation-post-dispatch";
    const postDispatchError = new Error("provider failed after dispatch");
    const generateSummaryWithUsage = vi.fn(async (...args: unknown[]) => {
      const onProviderDispatch = args[12];
      if (typeof onProviderDispatch !== "function") {
        throw new Error("missing provider dispatch callback");
      }
      onProviderDispatch();
      throw postDispatchError;
    });
    const { summarizeWithFallbackWithUsage } =
      await importCompactionWithSummaryGenerator(generateSummaryWithUsage);

    await withTempDir({ prefix: "openclaw-compaction-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const transcriptPath = path.join(stateDir, "agents", "main", "sessions", "summary.jsonl");
        await expect(
          summarizeWithFallbackWithUsage({
            ...summaryParams(),
            config: {
              agents: {
                defaults: {
                  usageBudget: {
                    daily: { tokens: 10_000 },
                  },
                },
              },
            },
            agentId: "main",
            transcriptPath,
            usageBudgetOperationId: operationId,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: {
            reason: "missing_window_usage",
            missingUsageEntries: 1,
          },
        });

        expect(generateSummaryWithUsage.mock.calls[0]?.[10]).toBeUndefined();
        expect(generateSummaryWithUsage.mock.calls[0]?.[11]).toBe(operationId);
        expect(generateSummaryWithUsage.mock.calls[0]?.[12]).toEqual(expect.any(Function));
        const transcript = await fs.readFile(transcriptPath, "utf8");
        expect(transcript).toContain(MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE);
        expect(transcript).toContain(`"${USAGE_BUDGET_OPERATION_ID_KEY}":"${operationId}"`);
        expect(transcript).toContain('"stopReason":"error"');
      });
    });
    vi.doUnmock("./sessions/index.js");
  });

  it("rejects budgeted summary calls before unobservable stream dispatch", async () => {
    const generateSummaryWithUsage = vi.fn(async () => ({
      summary: "should not dispatch",
    }));
    const { summarizeWithFallbackWithUsage } = await importCompactionWithSummaryGenerator(
      generateSummaryWithUsage,
      false,
    );

    await withTempDir({ prefix: "openclaw-compaction-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const transcriptPath = path.join(stateDir, "agents", "main", "sessions", "summary.jsonl");
        await expect(
          summarizeWithFallbackWithUsage({
            ...summaryParams(),
            config: {
              agents: {
                defaults: {
                  usageBudget: {
                    daily: { tokens: 10_000 },
                  },
                },
              },
            },
            agentId: "main",
            transcriptPath,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: {
            agentId: "main",
            provider: "openai",
            model: "gpt-5.4",
            reason: "unsupported_stream",
          },
        });

        await expect(fs.readFile(transcriptPath, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    });
    expect(generateSummaryWithUsage).not.toHaveBeenCalled();
  });

  it("does not count the terminal failed retry usage twice", async () => {
    const failedUsage = {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.012 },
    };
    const { summarizeWithFallbackWithUsage } = await importCompactionWithSummaryGenerator(
      async () => {
        throw Object.assign(new Error("transient"), { usage: failedUsage });
      },
    );

    const result = await summarizeWithFallbackWithUsage(summaryParams());

    expect(result.summary).toContain("Summary unavailable");
    expect(result.usage?.totalTokens).toBe(36);
    expect(result.usage?.cost.total).toBeCloseTo(0.036, 8);
    vi.doUnmock("./sessions/index.js");
  });

  it("retains usage from failed oversized fallback attempts", async () => {
    const failedUsage = {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.012 },
    };
    const { summarizeWithFallbackWithUsage } = await importCompactionWithSummaryGenerator(
      async () => {
        throw Object.assign(new Error("transient"), { usage: failedUsage });
      },
    );

    const result = await summarizeWithFallbackWithUsage({
      ...summaryParams(),
      messages: [makeMessage(1, 20), makeMessage(2, 1_000)],
      contextWindow: 100,
      maxChunkTokens: 100,
    });

    expect(result.summary).toContain("Summary unavailable");
    expect(result.usage?.totalTokens).toBe(72);
    expect(result.usage?.cost.total).toBeCloseTo(0.072, 8);
    vi.doUnmock("./sessions/index.js");
  });

  it("carries earlier staged usage through later failures", async () => {
    const firstUsage = {
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 25,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.025 },
    };
    const error = new AgentUsageBudgetError("blocked", {
      agentId: "main",
      provider: "openai",
      model: "gpt-5.4",
      reason: "exceeded",
    });
    let attempts = 0;
    const { summarizeInStagesWithUsage } = await importCompactionWithSummaryGenerator(async () => {
      attempts += 1;
      if (attempts === 1) {
        return { summary: "first", usage: firstUsage };
      }
      throw error;
    });

    await expect(
      summarizeInStagesWithUsage({
        ...summaryParams(),
        messages: makeMessages(4, 4000),
        parts: 2,
        minMessagesForSplit: 1,
        maxChunkTokens: 1000,
      }),
    ).rejects.toSatisfy((thrown: unknown) => {
      expect(thrown).toBe(error);
      expect(
        (thrown as { partialUsage?: AssistantMessage["usage"] }).partialUsage?.totalTokens,
      ).toBe(25);
      return true;
    });
    vi.doUnmock("./sessions/index.js");
  });
});

function makeMessage(id: number, size: number): AgentMessage {
  return {
    role: "user",
    content: "x".repeat(size),
    timestamp: id,
  };
}

function makeMessages(count: number, size: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => makeMessage(index + 1, size));
}

function compareTimestampIds(left: AgentMessage["timestamp"], right: AgentMessage["timestamp"]) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function makeAssistantToolCall(
  timestamp: number,
  toolCallId: string,
  text = "x".repeat(4000),
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  // Tool-call fixtures use real assistant message structure so split/prune
  // helpers preserve tool-call/result adjacency like production transcripts.
  return makeAgentAssistantMessage({
    content: [
      { type: "text", text },
      { type: "toolCall", id: toolCallId, name: "test_tool", arguments: {} },
    ],
    model: "gpt-5.4",
    stopReason,
    timestamp,
  });
}

function makeToolResult(timestamp: number, toolCallId: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "test_tool",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function pruneLargeSimpleHistory() {
  const messages = makeMessages(4, 4000);
  const maxContextTokens = 2000; // budget is 1000 tokens (50%)
  const pruned = pruneHistoryForContextShare({
    messages,
    maxContextTokens,
    maxHistoryShare: 0.5,
    parts: 2,
  });
  return { messages, pruned, maxContextTokens };
}

function requireChunkContainingTimestamp(
  parts: AgentMessage[][],
  role: AgentMessage["role"],
  timestamp: number,
): AgentMessage[] {
  const chunk = parts.find((candidate) =>
    candidate.some((message) => message.role === role && message.timestamp === timestamp),
  );
  if (!chunk) {
    throw new Error(`expected ${role} message with timestamp ${timestamp} in a chunk`);
  }
  return chunk;
}

describe("splitMessagesByTokenShare", () => {
  it("splits messages into two non-empty parts", () => {
    const messages = makeMessages(4, 4000);

    const parts = splitMessagesByTokenShare(messages, 2);
    expect(parts.map((chunk) => chunk.map((msg) => msg.timestamp))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("preserves message order across parts", () => {
    const messages = makeMessages(6, 4000);

    const parts = splitMessagesByTokenShare(messages, 3);
    expect(parts.flat().map((msg) => msg.timestamp)).toEqual(messages.map((msg) => msg.timestamp));
  });

  it("keeps tool_use and matching toolResult in the same chunk", () => {
    // Splitting a tool call from its result creates invalid replay context for
    // downstream summarization and provider transcript reuse.
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_split"),
      makeToolResult(3, "call_split", "r".repeat(800)),
      makeMessage(4, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    const chunkWithToolUse = requireChunkContainingTimestamp(parts, "assistant", 2);
    const chunkWithToolResult = requireChunkContainingTimestamp(parts, "toolResult", 3);
    expect(chunkWithToolUse).toBe(chunkWithToolResult);
    expect(parts.flat().length).toBe(messages.length);
  });

  it("keeps multiple toolResults with their assistant in the same chunk", () => {
    const assistant = makeAgentAssistantMessage({
      content: [
        { type: "text", text: "x".repeat(4000) },
        { type: "toolCall", id: "call_a", name: "tool_a", arguments: {} },
        { type: "toolCall", id: "call_b", name: "tool_b", arguments: {} },
      ],
      model: "gpt-5.2",
      stopReason: "stop",
      timestamp: 2,
    });

    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      assistant,
      makeToolResult(3, "call_a", "result_a".repeat(200)),
      makeToolResult(4, "call_b", "result_b".repeat(200)),
      makeMessage(5, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    const chunkWithAssistant = parts.find((chunk) =>
      chunk.some((m) => m.role === "assistant" && m.timestamp === 2),
    )!;
    const resultTimestamps = chunkWithAssistant
      .filter((m) => m.role === "toolResult")
      .map((m) => m.timestamp);
    expect(resultTimestamps).toEqual([3, 4]);
    expect(parts.flat().length).toBe(messages.length);
  });

  it("keeps displaced toolResults with their assistant chunk", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_split"),
      makeMessage(3, 800),
      makeToolResult(4, "call_split", "r".repeat(800)),
      makeMessage(5, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    const chunkWithToolUse = requireChunkContainingTimestamp(parts, "assistant", 2);
    const chunkWithToolResult = requireChunkContainingTimestamp(parts, "toolResult", 4);

    expect(chunkWithToolUse).toBe(chunkWithToolResult);
  });

  it("splits after a completed tool_call/result pair when over budget", () => {
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_x", "y".repeat(4000)),
      makeToolResult(2, "call_x", "r".repeat(4000)),
      makeMessage(3, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.map((chunk) => chunk.map((msg) => msg.timestamp))).toEqual([[1, 2], [3]]);
  });

  it("splits before a trailing completed tool-call pair", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_tail", "y".repeat(200)),
      makeToolResult(3, "call_tail", "r".repeat(4000)),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.length).toBe(2);
    expect(parts[0]?.map((m) => m.timestamp)).toEqual([1]);
    expect(parts[1]?.map((m) => m.timestamp)).toEqual([2, 3]);
  });

  it("does not block splits after aborted tool-call assistants", () => {
    // Aborted tool-use turns have no required result, so they should not pin
    // later messages to the same chunk.
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_abort", "y".repeat(4000), "aborted"),
      makeMessage(2, 4000),
      makeMessage(3, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.map((chunk) => chunk.map((msg) => msg.timestamp))).toEqual([[1], [2, 3]]);
  });

  it("splits before unfinished tool-call turns that never get a result", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_missing"),
      makeMessage(3, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.length).toBe(2);
    expect(parts[0]?.map((m) => m.timestamp)).toEqual([1]);
    expect(parts[1]?.map((m) => m.timestamp)).toEqual([2, 3]);
  });
});

describe("pruneHistoryForContextShare", () => {
  it("drops older chunks until the history budget is met", () => {
    const { pruned, maxContextTokens } = pruneLargeSimpleHistory();

    expect(pruned.droppedChunks).toBe(2);
    expect(pruned.keptTokens).toBeLessThanOrEqual(Math.floor(maxContextTokens * 0.5));
    expect(pruned.messages.map((msg) => msg.timestamp)).toEqual([4]);
  });

  it("keeps the newest messages when pruning", () => {
    const messages = makeMessages(6, 4000);
    const totalTokens = estimateMessagesTokens(messages);
    const maxContextTokens = Math.max(1, Math.floor(totalTokens * 0.5)); // budget = 25%
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    const keptIds = pruned.messages.map((msg) => msg.timestamp);
    const expectedSuffix = messages.slice(-keptIds.length).map((msg) => msg.timestamp);
    expect(keptIds).toEqual(expectedSuffix);
  });

  it("keeps history when already within budget", () => {
    const messages: AgentMessage[] = [makeMessage(1, 1000)];
    const maxContextTokens = 2000;
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedChunks).toBe(0);
    expect(pruned.messages.length).toBe(messages.length);
    expect(pruned.keptTokens).toBe(estimateMessagesTokens(messages));
    expect(pruned.droppedMessagesList).toStrictEqual([]);
  });

  it("returns droppedMessagesList containing dropped messages", () => {
    const { messages, pruned } = pruneLargeSimpleHistory();

    expect(pruned.droppedChunks).toBe(2);
    expect(pruned.droppedMessagesList.map((msg) => msg.timestamp)).toEqual([1, 2, 3]);
    expect(pruned.droppedMessagesList.length).toBe(pruned.droppedMessages);

    const allIds = [
      ...pruned.droppedMessagesList.map((m) => m.timestamp),
      ...pruned.messages.map((m) => m.timestamp),
    ].toSorted(compareTimestampIds);
    const originalIds = messages.map((m) => m.timestamp).toSorted(compareTimestampIds);
    expect(allIds).toEqual(originalIds);
  });

  it("returns empty droppedMessagesList when no pruning needed", () => {
    const messages: AgentMessage[] = [makeMessage(1, 100)];
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 100_000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedChunks).toBe(0);
    expect(pruned.droppedMessagesList).toStrictEqual([]);
    expect(pruned.messages.length).toBe(1);
  });

  it("removes orphaned tool_result messages when tool_use is dropped", () => {
    // Pruning the assistant tool_use must also drop its result; orphaned
    // toolResult messages are not meaningful model context.
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_123"),
      makeToolResult(2, "call_123", "result".repeat(500)),
      {
        role: "user",
        content: "x".repeat(500),
        timestamp: 3,
      },
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    const keptRoles = pruned.messages.map((m) => m.role);
    expect(keptRoles).not.toContain("toolResult");
    expect(pruned.droppedMessages).toBe(pruned.droppedMessagesList.length);
  });

  it("keeps tool_result when its tool_use is also kept", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "x".repeat(4000),
        timestamp: 1,
      },
      makeAssistantToolCall(2, "call_456", "y".repeat(500)),
      makeToolResult(3, "call_456", "result"),
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    const keptRoles = pruned.messages.map((m) => m.role);
    expect(keptRoles).toContain("assistant");
    expect(keptRoles).toContain("toolResult");
  });

  it("removes multiple orphaned tool_results from the same dropped tool_use", () => {
    const messages: AgentMessage[] = [
      makeAgentAssistantMessage({
        content: [
          { type: "text", text: "x".repeat(4000) },
          { type: "toolCall", id: "call_a", name: "tool_a", arguments: {} },
          { type: "toolCall", id: "call_b", name: "tool_b", arguments: {} },
        ],
        model: "gpt-5.4",
        stopReason: "stop",
        timestamp: 1,
      }),
      makeToolResult(2, "call_a", "result_a"),
      makeToolResult(3, "call_b", "result_b"),
      {
        role: "user",
        content: "x".repeat(500),
        timestamp: 4,
      },
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    const keptToolResults = pruned.messages.filter((m) => m.role === "toolResult");
    expect(keptToolResults).toHaveLength(0);
    expect(pruned.droppedMessages).toBe(pruned.droppedMessagesList.length);
  });
});
