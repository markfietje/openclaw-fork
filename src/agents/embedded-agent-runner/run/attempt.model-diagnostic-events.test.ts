// Coverage for model-call diagnostic events around attempt stream functions.
import fs from "node:fs/promises";
import path from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markProviderDispatchCostMultiplierResolverStreamFn,
  markProviderDispatchModelResolverStreamFn,
  markProviderDispatchObservableStreamFn,
} from "../../../../packages/llm-core/src/provider-dispatch-observable-stream.js";
import { withEnvOverride } from "../../../config/test-helpers.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPrivateData,
  type DiagnosticEventPayload,
  waitForDiagnosticEventsDrained,
} from "../../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
} from "../../../logging/diagnostic-run-activity.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-helpers.js";
import {
  attachUsageBudgetRecordedCostMetadata,
  USAGE_BUDGET_RECORDED_COST_METADATA_KEY,
} from "../../../shared/usage-budget-recorded-cost.js";
import { withTempDir } from "../../../test-helpers/temp-dir.js";
import {
  MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE,
  USAGE_BUDGET_OPERATION_ID_KEY,
} from "../../compaction-usage-accounting.js";
import { prepareGooglePromptCacheStreamFn } from "../google-prompt-cache.js";
import {
  cancelObservedModelCallStream,
  wrapStreamFnWithDiagnosticModelCallEvents,
} from "./attempt.model-diagnostic-events.js";

async function collectModelCallEvents(run: () => Promise<void>): Promise<DiagnosticEventPayload[]> {
  // Diagnostics are emitted asynchronously; collect only public model-call
  // events and flush one tick after the stream completes.
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event) => {
    if (event.type.startsWith("model.call.")) {
      events.push(event);
    }
  });
  try {
    await run();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    return events;
  } finally {
    stop();
  }
}

async function collectTrustedModelCallEvents(run: () => Promise<void>): Promise<
  Array<{
    event: DiagnosticEventPayload;
    privateData: DiagnosticEventPrivateData;
  }>
> {
  const events: Array<{
    event: DiagnosticEventPayload;
    privateData: DiagnosticEventPrivateData;
  }> = [];
  const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
    if (event.type.startsWith("model.call.")) {
      events.push({ event, privateData });
    }
  });
  try {
    await run();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    return events;
  } finally {
    stop();
  }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  // Force stream iteration so completion events include response byte and timing
  // accounting.
  for await (const _ of stream) {
    // drain
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function readRecordField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function expectNumberField(record: Record<string, unknown>, key: string) {
  expect(typeof record[key]).toBe("number");
}

function createUsageBudgetAssistantMessage(timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    provider: "openai",
    model: "gpt-5.4",
    api: "openai-responses",
    stopReason: "stop",
    timestamp,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function getEvent(events: readonly DiagnosticEventPayload[], index: number) {
  return requireRecord(events[index], `event ${index}`);
}

function requireMockRecordArg(
  mock: ReturnType<typeof vi.fn>,
  callIndex: number,
  argIndex: number,
  label: string,
) {
  return requireRecord(mock.mock.calls[callIndex]?.[argIndex], label);
}

describe("wrapStreamFnWithDiagnosticModelCallEvents", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticRunActivityForTest();
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("emits started and completed events for async streams", async () => {
    // Request payloads are measured for diagnostics but must be redacted from
    // public event bodies.
    async function* stream() {
      yield { type: "text", text: "ok" };
    }
    const originalStream = stream() as unknown as AsyncIterable<unknown> & {
      result: () => Promise<string>;
    };
    originalStream.result = async () => "kept";
    const requestPayload = {
      input: [{ role: "user", content: "secret prompt sk-test-secret-value" }],
      model: "gpt-5.4",
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      ((
        model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        options?.onPayload?.(requestPayload, model);
        return originalStream;
      }) as unknown as StreamFn,
      {
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "openai",
        model: "gpt-5.4",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
        }),
        nextCallId: () => "call-1",
      },
    );

    const events = await collectModelCallEvents(async () => {
      const returned = wrapped(
        {} as never,
        {} as never,
        {} as never,
      ) as unknown as typeof originalStream;
      expect(returned).not.toBe(originalStream);
      expect(await returned.result()).toBe("kept");
      await drain(returned);
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    const startedEvent = getEvent(events, 0);
    expect(startedEvent.type).toBe("model.call.started");
    expect(startedEvent.runId).toBe("run-1");
    expect(startedEvent.callId).toBe("call-1");
    expect(startedEvent.sessionKey).toBe("session-key");
    expect(startedEvent.sessionId).toBe("session-id");
    expect(startedEvent.provider).toBe("openai");
    expect(startedEvent.model).toBe("gpt-5.4");
    expect(startedEvent.api).toBe("openai-responses");
    expect(startedEvent.transport).toBe("http");
    expect(events[0]?.trace?.parentSpanId).toBe("00f067aa0ba902b7");
    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.callId).toBe("call-1");
    expectNumberField(completedEvent, "durationMs");
    expect(completedEvent.requestPayloadBytes).toBe(
      Buffer.byteLength(JSON.stringify(requestPayload), "utf8"),
    );
    expectNumberField(completedEvent, "responseStreamBytes");
    expectNumberField(completedEvent, "timeToFirstByteMs");
    expect(JSON.stringify(events)).not.toContain("sk-test-secret-value");
  });

  it("blocks usage-budget denials before provider stream dispatch", async () => {
    const streamFn = vi.fn(() => {
      throw new Error("provider should not be called");
    }) as unknown as StreamFn;
    markProviderDispatchObservableStreamFn(streamFn);
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
      runId: "run-budget",
      sessionId: "session-id",
      provider: "budget-missing",
      model: "unpriced",
      api: "openai-responses",
      transport: "http",
      trace: createDiagnosticTraceContext(),
      config: {
        agents: {
          defaults: {
            usageBudget: {
              daily: { usd: 1 },
            },
          },
        },
      },
      agentId: "main",
      nextCallId: () => "call-budget",
    });

    let caught: unknown;
    const events = await collectModelCallEvents(async () => {
      try {
        await wrapped({} as never, {} as never, {} as never);
      } catch (err) {
        caught = err;
      }
    });

    expect(streamFn).not.toHaveBeenCalled();
    expect(caught).toMatchObject({
      code: "agent_usage_budget_blocked",
      details: { reason: "missing_model_pricing" },
    });
    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
  });

  it("blocks Google prompt-cache management before provider cache dispatch", async () => {
    const cacheFetch = vi.fn<typeof fetch>();
    const innerStreamFn = vi.fn(() => createAssistantMessageEventStream()) as unknown as StreamFn;
    markProviderDispatchObservableStreamFn(innerStreamFn);
    const model = {
      id: "gemini-3.1-pro-preview",
      name: "Gemini",
      api: "google-generative-ai",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    };
    const cacheWrapped = await prepareGooglePromptCacheStreamFn(
      {
        apiKey: "gemini-api-key",
        extraParams: { cacheRetention: "long" },
        model: model as never,
        modelId: "gemini-3.1-pro-preview",
        provider: "google",
        sessionManager: {
          appendCustomEntry: vi.fn(),
          getEntries: () => [],
        },
        streamFn: innerStreamFn,
        systemPrompt: "Follow policy.",
      },
      {
        buildGuardedFetch: () => cacheFetch,
        now: () => Date.UTC(2026, 6, 15, 12),
      },
    );
    expect(cacheWrapped).toBeTypeOf("function");
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(cacheWrapped as StreamFn, {
      runId: "run-budget-google-cache",
      sessionId: "session-id",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      api: "google-generative-ai",
      transport: "http",
      trace: createDiagnosticTraceContext(),
      config: {
        agents: {
          defaults: {
            usageBudget: {
              daily: { tokens: 1 },
            },
          },
        },
      },
      agentId: "budget-google-cache",
      nextCallId: () => "call-budget-google-cache",
    });

    let caught: unknown;
    const events = await collectModelCallEvents(async () => {
      try {
        await wrapped(
          model as never,
          {
            systemPrompt: "Follow policy.",
            messages: [{ role: "user", content: "hello" }],
            tools: [
              {
                name: "lookup",
                description: "Lookup",
                parameters: { type: "object", properties: {} },
              },
            ],
          } as never,
          { maxTokens: 4096 } as never,
        );
      } catch (err) {
        caught = err;
      }
    });

    expect(cacheFetch).not.toHaveBeenCalled();
    expect(innerStreamFn).not.toHaveBeenCalled();
    expect(caught).toMatchObject({
      code: "agent_usage_budget_blocked",
      details: { reason: "exceeded", limitKind: "tokens" },
    });
    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
  });

  it("prices usage-budget admission against the resolved dispatch model", async () => {
    const streamFn = vi.fn(() => createAssistantMessageEventStream()) as unknown as StreamFn;
    markProviderDispatchObservableStreamFn(streamFn);
    markProviderDispatchModelResolverStreamFn(streamFn, ({ model }) => ({
      ...model,
      id: "grok-3-fast",
    }));
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
      runId: "run-budget-dispatch-model",
      sessionId: "session-id",
      provider: "xai",
      model: "grok-3",
      api: "openai-responses",
      transport: "http",
      trace: createDiagnosticTraceContext(),
      config: {
        agents: {
          defaults: {
            usageBudget: {
              daily: { usd: 1 },
            },
          },
        },
        models: {
          providers: {
            xai: {
              baseUrl: "https://api.x.ai/v1",
              models: [
                {
                  id: "grok-3",
                  name: "grok-3",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      agentId: "budget-dispatch-model",
      nextCallId: () => "call-budget-dispatch-model",
    });

    let caught: unknown;
    await collectModelCallEvents(async () => {
      try {
        await wrapped(
          {
            id: "grok-3",
            name: "grok-3",
            api: "openai-responses",
            provider: "xai",
            reasoning: false,
            input: ["text"],
            cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          } as never,
          { messages: [{ role: "user", content: "hello" }] } as never,
          { maxTokens: 4096 } as never,
        );
      } catch (err) {
        caught = err;
      }
    });

    expect(streamFn).not.toHaveBeenCalled();
    expect(caught).toMatchObject({
      code: "agent_usage_budget_blocked",
      details: { reason: "missing_model_pricing" },
    });
  });

  it("prices usage-budget admission with provider dispatch cost multipliers", async () => {
    const streamFn = vi.fn(() => createAssistantMessageEventStream()) as unknown as StreamFn;
    markProviderDispatchObservableStreamFn(streamFn);
    markProviderDispatchCostMultiplierResolverStreamFn(streamFn, () => 2);
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
      runId: "run-budget-cost-multiplier",
      sessionId: "session-id",
      provider: "openai",
      model: "gpt-5.4",
      api: "openai-responses",
      transport: "http",
      trace: createDiagnosticTraceContext(),
      config: {
        agents: {
          defaults: {
            usageBudget: {
              daily: { usd: 0.000015 },
            },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.4",
                  name: "gpt-5.4",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      agentId: "budget-cost-multiplier",
      nextCallId: () => "call-budget-cost-multiplier",
    });

    let caught: unknown;
    await collectModelCallEvents(async () => {
      try {
        await wrapped(
          {
            id: "gpt-5.4",
            name: "gpt-5.4",
            api: "openai-responses",
            provider: "openai",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          } as never,
          { messages: [{ role: "user", content: "hello" }] } as never,
          { maxTokens: 10 } as never,
        );
      } catch (err) {
        caught = err;
      }
    });

    expect(streamFn).not.toHaveBeenCalled();
    expect(caught).toMatchObject({
      code: "agent_usage_budget_blocked",
      details: { reason: "exceeded", limitKind: "spend" },
    });
  });

  it("persists provider dispatch cost multipliers for completed usage-budget calls", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const transcriptPath = path.join(
          stateDir,
          "agents",
          "budget-cost-multiplier-ledger",
          "sessions",
          "s.jsonl",
        );
        const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
        const streamFn = vi.fn<StreamFn>(() => {
          const stream = createAssistantMessageEventStream();
          streams.push(stream);
          return stream;
        });
        markProviderDispatchObservableStreamFn(streamFn);
        markProviderDispatchCostMultiplierResolverStreamFn(streamFn, () => 2);
        const config: OpenClawConfig = {
          agents: {
            defaults: {
              usageBudget: {
                daily: { usd: 0.000021 },
              },
            },
          },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                models: [
                  {
                    id: "gpt-5.4",
                    name: "gpt-5.4",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        };
        const model = {
          id: "gpt-5.4",
          name: "gpt-5.4",
          api: "openai-responses",
          provider: "openai",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        } as never;
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-cost-multiplier-ledger",
          sessionId: "session-id",
          transcriptPath,
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config,
          agentId: "budget-cost-multiplier-ledger",
          nextCallId: () => `call-budget-cost-multiplier-ledger-${streamFn.mock.calls.length + 1}`,
        });

        const first = (await Promise.resolve(
          wrapped(
            model,
            { messages: [{ role: "user", content: "hello" }] } as never,
            { maxTokens: 10 } as never,
          ),
        )) as ReturnType<typeof createAssistantMessageEventStream>;
        streams[0]?.end({
          ...createUsageBudgetAssistantMessage(10),
          usage: {
            input: 0,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        });
        await first.result();

        await vi.waitFor(async () => {
          const transcript = await fs.readFile(transcriptPath, "utf8");
          const row = transcript
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .find((entry) => entry.id === "call-budget-cost-multiplier-ledger-1:usage");
          const data = requireRecord(row?.data, "model-call usage data");
          const message = requireRecord(data.message, "model-call usage message");
          const usage = requireRecord(message.usage, "model-call usage");
          const cost = requireRecord(usage.cost, "model-call usage cost");
          expect(cost.total).toBeCloseTo(0.00002);
        });

        let caught: unknown;
        await collectModelCallEvents(async () => {
          try {
            await wrapped(
              model,
              { messages: [{ role: "user", content: "again" }] } as never,
              { maxTokens: 1 } as never,
            );
          } catch (err) {
            caught = err;
          }
        });

        expect(streamFn).toHaveBeenCalledTimes(1);
        expect(caught).toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", limitKind: "spend" },
        });
      });
    });
  });

  it("preserves provider-recorded auto-tier costs for budgeted embedded calls", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const transcriptPath = path.join(
          stateDir,
          "agents",
          "budget-recorded-cost-ledger",
          "sessions",
          "s.jsonl",
        );
        const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
        const streamFn = vi.fn<StreamFn>(() => {
          const stream = createAssistantMessageEventStream();
          streams.push(stream);
          return stream;
        });
        markProviderDispatchObservableStreamFn(streamFn);
        const config: OpenClawConfig = {
          agents: {
            defaults: {
              usageBudget: {
                daily: { usd: 0.00003 },
              },
            },
          },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                models: [
                  {
                    id: "gpt-5.5",
                    name: "gpt-5.5",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        };
        const model = {
          id: "gpt-5.5",
          name: "gpt-5.5",
          api: "openai-responses",
          provider: "openai",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        } as never;
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-recorded-cost-ledger",
          sessionId: "session-id",
          transcriptPath,
          provider: "openai",
          model: "gpt-5.5",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config,
          agentId: "budget-recorded-cost-ledger",
          nextCallId: () => `call-budget-recorded-cost-ledger-${streamFn.mock.calls.length + 1}`,
        });

        const first = (await Promise.resolve(
          wrapped(
            model,
            { messages: [{ role: "user", content: "hello" }] } as never,
            { maxTokens: 10 } as never,
          ),
        )) as ReturnType<typeof createAssistantMessageEventStream>;
        const usage: Record<string, unknown> = {
          input: 0,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 10,
          cost: {
            input: 0,
            output: 0.000025,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.000025,
          },
        };
        attachUsageBudgetRecordedCostMetadata(usage, 2.5);
        streams[0]?.end({
          ...createUsageBudgetAssistantMessage(10),
          model: "gpt-5.5",
          usage: usage as never,
        });
        await first.result();

        await vi.waitFor(async () => {
          const transcript = await fs.readFile(transcriptPath, "utf8");
          const row = transcript
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .find((entry) => entry.id === "call-budget-recorded-cost-ledger-1:usage");
          const data = requireRecord(row?.data, "model-call usage data");
          const message = requireRecord(data.message, "model-call usage message");
          const recordedUsage = requireRecord(message.usage, "model-call usage");
          const cost = requireRecord(recordedUsage.cost, "model-call usage cost");
          expect(cost.total).toBeCloseTo(0.000025);
          const metadata = requireRecord(
            recordedUsage[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
            "recorded cost metadata",
          );
          expect(metadata.costMultiplier).toBe(2.5);
        });

        let caught: unknown;
        await collectModelCallEvents(async () => {
          try {
            await wrapped(
              model,
              { messages: [{ role: "user", content: "again" }] } as never,
              { maxTokens: 10 } as never,
            );
          } catch (err) {
            caught = err;
          }
        });

        expect(streamFn).toHaveBeenCalledTimes(1);
        expect(caught).toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", limitKind: "spend" },
        });
      });
    });
  });

  it("blocks budgeted custom streams without provider-dispatch accounting", async () => {
    const streamFn = vi.fn<StreamFn>(() => {
      throw new Error("provider should not be called");
    });
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
      runId: "run-budget-unsupported-stream",
      sessionId: "session-id",
      provider: "openai",
      model: "gpt-5.4",
      api: "openai-responses",
      transport: "http",
      trace: createDiagnosticTraceContext(),
      config: {
        agents: {
          defaults: {
            usageBudget: {
              daily: { tokens: 100 },
            },
          },
        },
      },
      agentId: "budget-unsupported-stream",
      nextCallId: () => "call-budget-unsupported-stream",
    });

    let caught: unknown;
    const events = await collectModelCallEvents(async () => {
      try {
        await wrapped({} as never, {} as never, {} as never);
      } catch (err) {
        caught = err;
      }
    });

    expect(streamFn).not.toHaveBeenCalled();
    expect(caught).toMatchObject({
      code: "agent_usage_budget_blocked",
      details: { reason: "unsupported_stream" },
    });
    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
  });

  it("reserves the request output cap instead of the catalog model maximum", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        async function* stream() {
          yield {
            type: "done",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          };
        }
        const streamFn = vi.fn(() => stream()) as unknown as StreamFn;
        markProviderDispatchObservableStreamFn(streamFn);
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-request-cap",
          sessionId: "session-id",
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          trace: createDiagnosticTraceContext(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 20 },
                },
              },
            },
          },
          agentId: "budget-request-cap",
          nextCallId: () => "call-budget-request-cap",
        });

        const returned = await Promise.resolve(
          wrapped({ maxTokens: 0 } as never, {} as never, { maxTokens: 10 } as never),
        );
        await drain(returned as AsyncIterable<unknown>);

        expect(streamFn).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("serializes same-agent budgeted provider calls until the observed call completes", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const firstStream = createAssistantMessageEventStream();
        const streamFn = vi.fn<StreamFn>(() => firstStream);
        markProviderDispatchObservableStreamFn(streamFn);
        let callIndex = 0;
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-serialized",
          sessionId: "session-id",
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 2 },
                },
              },
            },
          },
          agentId: "budget-serialized",
          nextCallId: () => `call-budget-${++callIndex}`,
        });

        const firstReturned = (await Promise.resolve(
          wrapped({} as never, {} as never, {} as never),
        )) as typeof firstStream;
        const secondReturnedPromise = Promise.resolve(
          wrapped({} as never, {} as never, {} as never),
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });

        expect(streamFn).toHaveBeenCalledTimes(1);
        firstStream.end(createUsageBudgetAssistantMessage(1));
        await firstReturned.result();

        await expect(secondReturnedPromise).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", limitKind: "tokens" },
        });
        expect(streamFn).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("preserves usage-budget admission when an observed stream is canceled before consumption", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const firstStream = createAssistantMessageEventStream();
        const secondStream = createAssistantMessageEventStream();
        let providerCallCount = 0;
        const streamFn = vi.fn<StreamFn>(() => {
          providerCallCount += 1;
          return providerCallCount === 1 ? firstStream : secondStream;
        });
        markProviderDispatchObservableStreamFn(streamFn);
        let callIndex = 0;
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-canceled",
          sessionId: "session-id",
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 100 },
                },
              },
            },
          },
          agentId: "budget-canceled",
          nextCallId: () => `call-budget-canceled-${++callIndex}`,
        });

        const firstReturned = (await Promise.resolve(
          wrapped({} as never, {} as never, {} as never),
        )) as typeof firstStream;
        const secondReturnedPromise = Promise.resolve(
          wrapped({} as never, {} as never, {} as never),
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });

        expect(streamFn).toHaveBeenCalledTimes(1);
        await cancelObservedModelCallStream(firstReturned);

        await expect(secondReturnedPromise).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "missing_window_usage", limitKind: "tokens" },
        });
        expect(streamFn).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("aborts detached budgeted provider work before preserving a canceled admission", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
        let dispatchCount = 0;
        let firstSignal: AbortSignal | undefined;
        let resolveFirstProducer!: () => void;
        const firstProducerDone = new Promise<void>((resolve) => {
          resolveFirstProducer = resolve;
        });
        const streamFn = vi.fn<StreamFn>((_model, _context, options) => {
          const providerOptions = options as
            | { signal?: AbortSignal; onProviderDispatch?: () => void }
            | undefined;
          const stream = createAssistantMessageEventStream();
          streams.push(stream);
          const callIndex = streams.length;
          if (callIndex === 1) {
            firstSignal = providerOptions?.signal;
          }
          void (async () => {
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            if (providerOptions?.signal?.aborted) {
              if (callIndex === 1) {
                resolveFirstProducer();
              }
              return;
            }
            providerOptions?.onProviderDispatch?.();
            dispatchCount += 1;
            stream.end(createUsageBudgetAssistantMessage(callIndex));
            if (callIndex === 1) {
              resolveFirstProducer();
            }
          })();
          return stream;
        });
        markProviderDispatchObservableStreamFn(streamFn);
        let callIndex = 0;
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-canceled-detached",
          sessionId: "session-id",
          provider: "google",
          model: "gemini-test",
          api: "google-generative-ai",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 100 },
                },
              },
            },
          },
          agentId: "budget-canceled-detached",
          nextCallId: () => `call-budget-canceled-detached-${++callIndex}`,
        });

        const firstReturned = (await Promise.resolve(
          wrapped({} as never, {} as never, {} as never),
        )) as ReturnType<typeof createAssistantMessageEventStream>;
        await cancelObservedModelCallStream(firstReturned);
        expect(firstSignal?.aborted).toBe(true);
        await firstProducerDone;
        expect(dispatchCount).toBe(0);

        await expect(
          Promise.resolve(wrapped({} as never, {} as never, {} as never)),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "missing_window_usage", limitKind: "tokens" },
        });

        expect(streamFn).toHaveBeenCalledTimes(1);
        expect(dispatchCount).toBe(0);
      });
    });
  });

  it("preserves in-flight budget admission when iterator cleanup rejects", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        let returnCalled = false;
        const stream = {
          [Symbol.asyncIterator]() {
            let emitted = false;
            return {
              async next() {
                if (!emitted) {
                  emitted = true;
                  return {
                    done: false,
                    value: { type: "text_delta", delta: "hello" },
                  };
                }
                return new Promise<IteratorResult<unknown>>(() => {
                  // Keep the iterator pending until cancellation cleanup runs.
                });
              },
              async return() {
                returnCalled = true;
                throw new Error("provider cleanup failed");
              },
            };
          },
        };
        const streamFn = vi.fn<StreamFn>(() => stream as unknown as ReturnType<StreamFn>);
        markProviderDispatchObservableStreamFn(streamFn);
        let callIndex = 0;
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-cleanup-reject",
          sessionId: "session-id",
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 100 },
                },
              },
            },
          },
          agentId: "budget-cleanup-reject",
          nextCallId: () => `call-budget-cleanup-reject-${++callIndex}`,
        });

        const firstReturned = (await Promise.resolve(
          wrapped({} as never, {} as never, {} as never),
        )) as AsyncIterable<unknown>;
        const iterator = firstReturned[Symbol.asyncIterator]();
        await iterator.next();
        await cancelObservedModelCallStream(firstReturned);

        expect(returnCalled).toBe(true);
        await expect(
          Promise.resolve(wrapped({} as never, {} as never, {} as never)),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "missing_window_usage", limitKind: "tokens" },
        });
        expect(streamFn).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("persists model-call usage accounting before releasing budget admission", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const callStartedAt = Date.UTC(2026, 6, 15, 23, 59, 59, 900);
        const callCompletedAt = Date.UTC(2026, 6, 16, 0, 0, 0, 100);
        vi.useFakeTimers();
        vi.setSystemTime(callStartedAt);
        const transcriptPath = path.join(
          stateDir,
          "agents",
          "budget-durable",
          "sessions",
          "s.jsonl",
        );
        const stream = createAssistantMessageEventStream();
        const streamFn = vi.fn<StreamFn>(() => stream);
        markProviderDispatchObservableStreamFn(streamFn);
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-durable",
          sessionId: "session-id",
          transcriptPath,
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 100 },
                },
              },
            },
          },
          agentId: "budget-durable",
          nextCallId: () => "call-budget-durable",
        });

        const returned = (await Promise.resolve(
          wrapped({} as never, {} as never, {} as never),
        )) as typeof stream;
        vi.setSystemTime(callCompletedAt);
        const assistantMessage = createUsageBudgetAssistantMessage(callCompletedAt);
        stream.end(assistantMessage);
        const result = await returned.result();
        expect(result).toHaveProperty(
          USAGE_BUDGET_OPERATION_ID_KEY,
          "model-call:call-budget-durable",
        );

        await vi.waitFor(async () => {
          const transcript = await fs.readFile(transcriptPath, "utf8");
          expect(transcript).toContain(MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE);
          expect(transcript).toContain('"id":"call-budget-durable:usage"');
          const row = transcript
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .find((entry) => entry.id === "call-budget-durable:usage");
          expect(row?.timestamp).toBe(new Date(callStartedAt).toISOString());
          expect(
            requireRecord(row?.data, "model-call usage data")[USAGE_BUDGET_OPERATION_ID_KEY],
          ).toBe("model-call:call-budget-durable");
        });
      });
    });
  });

  it("does not record unknown usage when async setup fails before provider dispatch", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const transcriptPath = path.join(
          stateDir,
          "agents",
          "budget-preflight-error",
          "sessions",
          "s.jsonl",
        );
        const streamFn = vi.fn<StreamFn>(async () => {
          throw new Error("missing credentials");
        });
        markProviderDispatchObservableStreamFn(streamFn);
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-preflight-error",
          sessionId: "session-id",
          transcriptPath,
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 100 },
                },
              },
            },
          },
          agentId: "budget-preflight-error",
          nextCallId: () => "call-budget-preflight-error",
        });

        const events = await collectModelCallEvents(async () => {
          await expect(
            Promise.resolve(wrapped({} as never, {} as never, {} as never)),
          ).rejects.toThrow("missing credentials");
        });

        expect(events.map((event) => event.type)).toEqual([
          "model.call.started",
          "model.call.error",
        ]);
        await expect(fs.readFile(transcriptPath, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    });
  });

  it("does not record zero-usage terminal errors before provider dispatch", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const transcriptPath = path.join(
          stateDir,
          "agents",
          "budget-zero-error",
          "sessions",
          "s.jsonl",
        );
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text: "missing credentials" }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
          stopReason: "error",
          timestamp: 1,
        };
        async function* stream() {
          yield { type: "error", reason: "error", error: assistant };
        }
        const streamFn = (() => stream()) as unknown as StreamFn;
        markProviderDispatchObservableStreamFn(streamFn);
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-zero-error",
          sessionId: "session-id",
          transcriptPath,
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 100 },
                },
              },
            },
          },
          agentId: "budget-zero-error",
          nextCallId: () => "call-budget-zero-error",
        });

        const events = await collectModelCallEvents(async () => {
          const streamResult = await Promise.resolve(
            wrapped({} as never, {} as never, {} as never),
          );
          await drain(streamResult as AsyncIterable<unknown>);
        });

        expect(events.map((event) => event.type)).toEqual([
          "model.call.started",
          "model.call.completed",
        ]);
        await expect(fs.readFile(transcriptPath, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    });
  });

  it("records zero-usage terminal errors after provider dispatch", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const transcriptPath = path.join(
          stateDir,
          "agents",
          "budget-dispatched-terminal-error",
          "sessions",
          "s.jsonl",
        );
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text: "request failed after dispatch" }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
          stopReason: "error",
          timestamp: 1,
        };
        const streamFn = vi.fn<StreamFn>((_model, _context, options) => {
          options?.onProviderDispatch?.();
          async function* stream() {
            yield { type: "error", reason: "error", error: assistant };
          }
          return stream() as never;
        });
        markProviderDispatchObservableStreamFn(streamFn);
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-dispatched-terminal-error",
          sessionId: "session-id",
          transcriptPath,
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 100 },
                },
              },
            },
          },
          agentId: "budget-dispatched-terminal-error",
          nextCallId: () => "call-budget-dispatched-terminal-error",
        });

        const events = await collectModelCallEvents(async () => {
          const streamResult = await Promise.resolve(
            wrapped({} as never, {} as never, {} as never),
          );
          await drain(streamResult as AsyncIterable<unknown>);
        });

        expect(events.map((event) => event.type)).toEqual([
          "model.call.started",
          "model.call.completed",
        ]);
        await vi.waitFor(async () => {
          const transcript = await fs.readFile(transcriptPath, "utf8");
          expect(transcript).toContain(MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE);
          const row = transcript
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .find((entry) => entry.id === "call-budget-dispatched-terminal-error:usage");
          const data = requireRecord(row?.data, "model-call usage data");
          expect(data[USAGE_BUDGET_OPERATION_ID_KEY]).toBe(
            "model-call:call-budget-dispatched-terminal-error",
          );
          const message = requireRecord(data.message, "model-call usage message");
          const usage = requireRecord(message.usage, "model-call usage");
          expect(usage.total).toBe(0);
        });
      });
    });
  });

  it("records unknown usage after a budgeted provider dispatch rejects", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const transcriptPath = path.join(
          stateDir,
          "agents",
          "budget-dispatch-error",
          "sessions",
          "s.jsonl",
        );
        const streamFn = vi.fn<StreamFn>(async (_model, _context, options) => {
          options?.onProviderDispatch?.();
          throw new Error("connection dropped");
        });
        markProviderDispatchObservableStreamFn(streamFn);
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-dispatch-error",
          sessionId: "session-id",
          transcriptPath,
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 100 },
                },
              },
            },
          },
          agentId: "budget-dispatch-error",
          nextCallId: () => "call-budget-dispatch-error",
        });

        const events = await collectModelCallEvents(async () => {
          await expect(
            Promise.resolve(wrapped({} as never, {} as never, {} as never)),
          ).rejects.toThrow("connection dropped");
        });

        expect(events.map((event) => event.type)).toEqual([
          "model.call.started",
          "model.call.error",
        ]);
        await vi.waitFor(async () => {
          const transcript = await fs.readFile(transcriptPath, "utf8");
          expect(transcript).toContain(MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE);
          const row = transcript
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .find((entry) => entry.id === "call-budget-dispatch-error:usage");
          const data = requireRecord(row?.data, "model-call usage data");
          expect(data[USAGE_BUDGET_OPERATION_ID_KEY]).toBe("model-call:call-budget-dispatch-error");
          const message = requireRecord(data.message, "model-call usage message");
          expect(message.usage).toBeUndefined();
          expect(message.stopReason).toBe("error");
        });
      });
    });
  });

  it("disables provider retries and blocks repeated budgeted provider dispatches", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const transcriptPath = path.join(
          stateDir,
          "agents",
          "budget-retry-dispatch",
          "sessions",
          "s.jsonl",
        );
        const streamFn = vi.fn<StreamFn>((_model, _context, options) => {
          expect(options?.maxRetries).toBe(0);
          options?.onProviderDispatch?.();
          options?.onProviderDispatch?.();
          throw new Error("provider should not reach a second dispatch");
        });
        markProviderDispatchObservableStreamFn(streamFn);
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-retry-dispatch",
          sessionId: "session-id",
          transcriptPath,
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 100 },
                },
              },
            },
          },
          agentId: "budget-retry-dispatch",
          nextCallId: () => "call-budget-retry-dispatch",
        });

        const events = await collectModelCallEvents(async () => {
          await expect(
            Promise.resolve(wrapped({} as never, {} as never, { maxRetries: 2 } as never)),
          ).rejects.toMatchObject({
            code: "agent_usage_budget_blocked",
            details: {
              harnessId: "provider-retry",
              reason: "unsupported_harness",
            },
          });
        });

        expect(events.map((event) => event.type)).toEqual([
          "model.call.started",
          "model.call.error",
        ]);
        await vi.waitFor(async () => {
          const transcript = await fs.readFile(transcriptPath, "utf8");
          const row = transcript
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .find((entry) => entry.id === "call-budget-retry-dispatch:usage");
          const data = requireRecord(row?.data, "model-call usage data");
          const message = requireRecord(data.message, "model-call usage message");
          expect(message.usage).toBeUndefined();
          expect(message.stopReason).toBe("error");
        });
      });
    });
  });

  it("releases the usage-budget admission queue after synchronous provider throws", async () => {
    await withTempDir({ prefix: "openclaw-model-call-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const secondStream = createAssistantMessageEventStream();
        const streamFn = vi.fn<StreamFn>(() => {
          if (streamFn.mock.calls.length === 1) {
            throw new Error("provider sync failure");
          }
          return secondStream;
        });
        markProviderDispatchObservableStreamFn(streamFn);
        let callIndex = 0;
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
          runId: "run-budget-sync-throw",
          sessionId: "session-id",
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          config: {
            agents: {
              defaults: {
                usageBudget: {
                  daily: { tokens: 100 },
                },
              },
            },
          },
          agentId: "budget-sync",
          nextCallId: () => `call-budget-sync-${++callIndex}`,
        });

        await expect(
          Promise.resolve(wrapped({} as never, {} as never, {} as never)),
        ).rejects.toThrow("provider sync failure");

        const returned = (await Promise.resolve(
          wrapped({} as never, {} as never, {} as never),
        )) as typeof secondStream;
        secondStream.end(createUsageBudgetAssistantMessage(2));
        await returned.result();
        expect(streamFn).toHaveBeenCalledTimes(2);
      });
    });
  });

  it("updates diagnostic run activity from throttled stream chunks", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    async function* stream() {
      yield { type: "text_delta", delta: "first" };
      yield { type: "text_delta", delta: "second" };
      yield { type: "text_delta", delta: "third" };
    }
    const runProgressEvents: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress") {
        runProgressEvents.push(event);
      }
    });
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "vllm",
        model: "qwen/qwen3.5-9b",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-stream",
      },
    );

    const returned = wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>;
    const iterator = returned[Symbol.asyncIterator]();

    try {
      await iterator.next();
      await waitForDiagnosticEventsDrained();
      let snapshot = getDiagnosticSessionActivitySnapshot({
        sessionKey: "session-key",
        sessionId: "session-id",
      });
      expect(snapshot.activeWorkKind).toBe("model_call");
      expect(snapshot.lastProgressReason).toBe("model_call:stream_progress");
      expect(snapshot.lastProgressAgeMs).toBe(0);
      expect(runProgressEvents).toHaveLength(1);

      now += 10_000;
      await iterator.next();
      await waitForDiagnosticEventsDrained();
      snapshot = getDiagnosticSessionActivitySnapshot({
        sessionKey: "session-key",
        sessionId: "session-id",
      });
      expect(snapshot.lastProgressReason).toBe("model_call:stream_progress");
      expect(snapshot.lastProgressAgeMs).toBe(0);
      expect(runProgressEvents).toHaveLength(1);

      now += 30_000;
      await iterator.next();
      await waitForDiagnosticEventsDrained();
      snapshot = getDiagnosticSessionActivitySnapshot({
        sessionKey: "session-key",
        sessionId: "session-id",
      });
      expect(snapshot.lastProgressReason).toBe("model_call:stream_progress");
      expect(snapshot.lastProgressAgeMs).toBe(0);
      expect(runProgressEvents).toHaveLength(2);
    } finally {
      await iterator.return?.();
      await waitForDiagnosticEventsDrained();
      stop();
    }
  });

  it("does not retain stream progress activity when diagnostics are disabled", async () => {
    setDiagnosticsEnabledForProcess(false);
    const runProgressEvents: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress") {
        runProgressEvents.push(event);
      }
    });
    async function* stream() {
      yield { type: "text_delta", delta: "first" };
      yield { type: "text_delta", delta: "second" };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "vllm",
        model: "qwen/qwen3.5-9b",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-disabled-diagnostics",
      },
    );

    try {
      await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
      await waitForDiagnosticEventsDrained();
    } finally {
      stop();
    }

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionKey: "session-key",
        sessionId: "session-id",
      }),
    ).toEqual({});
    expect(runProgressEvents).toEqual([]);
  });

  it("counts async onPayload replacements instead of raw payload content", async () => {
    async function* stream() {
      yield { type: "text_delta", delta: "safe" };
    }
    const originalPayload = { input: "secret sk-original-secret" };
    const replacementPayload = { input: "redacted" };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (async (
        model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        await options?.onPayload?.(originalPayload, model);
        return stream();
      }) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-payload",
      },
    );

    const events = await collectModelCallEvents(async () => {
      const streamResult = await wrapped({} as never, {} as never, {
        onPayload: async () => replacementPayload,
      });
      await drain(streamResult as unknown as AsyncIterable<unknown>);
    });

    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.callId).toBe("call-payload");
    expect(completedEvent.requestPayloadBytes).toBe(
      Buffer.byteLength(JSON.stringify(replacementPayload), "utf8"),
    );
    expectNumberField(completedEvent, "responseStreamBytes");
    expectNumberField(completedEvent, "timeToFirstByteMs");
    expect(JSON.stringify(events)).not.toContain("sk-original-secret");
  });

  it("counts text deltas without serializing full partial snapshots", async () => {
    const serializedPartial = vi.fn(() => {
      throw new Error("partial snapshot should not be serialized for text deltas");
    });
    async function* stream() {
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "a",
        partial: {
          toJSON: serializedPartial,
          role: "assistant",
          content: [{ type: "text", text: "a".repeat(200_000) }],
        },
      };
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "bc",
        partial: {
          toJSON: serializedPartial,
          role: "assistant",
          content: [{ type: "text", text: "abc".repeat(200_000) }],
        },
      };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-delta-bytes",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    });

    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.responseStreamBytes).toBe(Buffer.byteLength("abc", "utf8"));
    expect(serializedPartial).not.toHaveBeenCalled();
  });

  it("keeps streams alive when diagnostic byte inspection cannot read a chunk", async () => {
    const opaqueChunk = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            return undefined;
          }
          throw new Error("chunk should not be inspected");
        },
      },
    );
    async function* stream() {
      yield opaqueChunk;
      yield { type: "text_delta", delta: "ok" };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-opaque-chunk",
      },
    );

    const chunks: unknown[] = [];
    const events = await collectModelCallEvents(async () => {
      for await (const chunk of wrapped(
        {} as never,
        {} as never,
        {} as never,
      ) as AsyncIterable<unknown>) {
        chunks.push(chunk);
      }
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(opaqueChunk);
    expect(chunks[1]).toEqual({ type: "text_delta", delta: "ok" });
    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.responseStreamBytes).toBe(Buffer.byteLength("ok", "utf8"));
  });

  it("captures model input, tools, and output only when content capture is enabled", async () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "trace reply" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "stop",
      timestamp: 1,
    };
    async function* stream() {
      yield { type: "done", reason: "stop", message: assistant };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        contentCapture: {
          inputMessages: true,
          outputMessages: true,
          toolInputs: false,
          toolOutputs: false,
          systemPrompt: true,
          toolDefinitions: true,
          anyModelContent: true,
        },
        nextCallId: () => "call-content",
      },
    );

    const inputMessages = [{ role: "user", content: "trace prompt", timestamp: 1 }];
    const tools = [{ name: "lookup", description: "Lookup data", parameters: { type: "object" } }];
    const events = await collectTrustedModelCallEvents(async () => {
      const streamResult = wrapped(
        {} as never,
        {
          systemPrompt: "trace system",
          messages: inputMessages,
          tools,
        } as never,
        {},
      );
      await drain(streamResult as unknown as AsyncIterable<unknown>);
    });

    const startedEvent = getEvent(
      events.map((entry) => entry.event),
      0,
    );
    expect(startedEvent.type).toBe("model.call.started");
    expect(startedEvent.inputMessages).toBeUndefined();
    expect(startedEvent.systemPrompt).toBeUndefined();
    expect(startedEvent.toolDefinitions).toBeUndefined();
    expect(events[0]?.privateData.modelContent?.inputMessages).toEqual(inputMessages);
    expect(events[0]?.privateData.modelContent?.systemPrompt).toBe("trace system");
    expect(events[0]?.privateData.modelContent?.toolDefinitions).toEqual(tools);
    const completedEvent = getEvent(
      events.map((entry) => entry.event),
      1,
    );
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.outputMessages).toBeUndefined();
    expect(events[1]?.privateData.modelContent?.inputMessages).toEqual(inputMessages);
    expect(events[1]?.privateData.modelContent?.outputMessages).toEqual([assistant]);
  });

  it("emits safe prompt stats and per-call usage without content capture", async () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "trace reply" }],
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        reasoningTokens: 5,
        totalTokens: 28,
      },
      timestamp: 1,
    };
    async function* stream() {
      yield { type: "done", reason: "stop", message: assistant };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-stats",
      },
    );

    const inputMessages = [{ role: "user", content: "private prompt text", timestamp: 1 }];
    const tools = [
      { name: "lookup", description: "private tool description", parameters: { type: "object" } },
    ];
    const systemPrompt = "private system prompt";
    const events = await collectModelCallEvents(async () => {
      const streamResult = wrapped(
        {} as never,
        {
          systemPrompt,
          messages: inputMessages,
          tools,
        } as never,
        {},
      );
      await drain(streamResult as unknown as AsyncIterable<unknown>);
    });

    const startedEvent = getEvent(events, 0);
    const completedEvent = getEvent(events, 1);
    const expectedPromptStats = {
      inputMessagesCount: inputMessages.length,
      inputMessagesChars: JSON.stringify(inputMessages).length,
      systemPromptChars: systemPrompt.length,
      toolDefinitionsCount: tools.length,
      toolDefinitionsChars: JSON.stringify(tools).length,
      totalChars:
        JSON.stringify(inputMessages).length + systemPrompt.length + JSON.stringify(tools).length,
    };
    expect(startedEvent.promptStats).toEqual(expectedPromptStats);
    expect(completedEvent.promptStats).toEqual(expectedPromptStats);
    expect(completedEvent.usage).toEqual({
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      reasoningTokens: 5,
      total: 28,
      promptTokens: 16,
    });
    expect(JSON.stringify(events)).not.toContain("private prompt text");
    expect(JSON.stringify(events)).not.toContain("private system prompt");
    expect(JSON.stringify(events)).not.toContain("private tool description");
  });

  it("captures per-call usage from terminal error events", async () => {
    // Aborted/error streams terminate with an `error` event carrying the final
    // AssistantMessage and its usage. Iterating to completion without awaiting
    // result() must still surface per-call usage, matching the `done` path and
    // the usage field already emitted on model.call.error and its OTel span.
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "partial reply" }],
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        reasoningTokens: 5,
        totalTokens: 28,
      },
      stopReason: "aborted",
      timestamp: 1,
    };
    async function* stream() {
      yield { type: "error", reason: "aborted", error: assistant };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openrouter",
        model: "openrouter/auto",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-error-usage",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    });

    // An in-band error event is data, not a throw, so iteration completes
    // normally; the per-call usage rides on the terminal completion event.
    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.usage).toEqual({
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      reasoningTokens: 5,
      total: 28,
      promptTokens: 16,
    });
  });

  it("skips prompt stat computation when diagnostics are disabled", async () => {
    // Prompt stats are only attached to diagnostic events; when diagnostics are
    // off those events are dropped, so the JSON.stringify of input messages and
    // tool definitions must not run on the model-call hot path.
    setDiagnosticsEnabledForProcess(false);
    let promptInspected = false;
    const streamContext = {
      systemPrompt: "system",
      get messages() {
        promptInspected = true;
        return [{ role: "user", content: "x", timestamp: 1 }];
      },
      get tools() {
        promptInspected = true;
        return [{ name: "lookup", description: "d", parameters: { type: "object" } }];
      },
    };
    async function* stream() {
      yield { type: "text_delta", delta: "ok" };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-disabled-prompt-stats",
      },
    );

    await drain(
      wrapped({} as never, streamContext as never, {} as never) as AsyncIterable<unknown>,
    );

    expect(promptInspected).toBe(false);
  });

  it("captures output and completes when callers only await stream.result()", async () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "compaction summary" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18 },
      stopReason: "stop",
      timestamp: 1,
    };
    const originalStream = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            throw new Error("result-only callers should not need stream iteration");
          },
        };
      },
      result: vi.fn(async () => assistant),
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => originalStream) as unknown as StreamFn,
      {
        runId: "run-compact",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        contentCapture: {
          inputMessages: true,
          outputMessages: true,
          toolInputs: false,
          toolOutputs: false,
          systemPrompt: true,
          toolDefinitions: true,
          anyModelContent: true,
        },
        nextCallId: () => "call-result-only",
      },
    );

    const inputMessages = [{ role: "user", content: "summarize this transcript", timestamp: 1 }];
    const events = await collectTrustedModelCallEvents(async () => {
      const streamResult = wrapped(
        {} as never,
        {
          systemPrompt: "summarize accurately",
          messages: inputMessages,
        } as never,
        {},
      ) as unknown as typeof originalStream;
      expect(await streamResult.result()).toBe(assistant);
    });

    expect(originalStream.result).toHaveBeenCalledOnce();
    expect(events.map(({ event }) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    const completedEvent = getEvent(
      events.map((entry) => entry.event),
      1,
    );
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.callId).toBe("call-result-only");
    expect(completedEvent.responseStreamBytes).toBe(
      Buffer.byteLength(JSON.stringify(assistant), "utf8"),
    );
    expect(events[1]?.privateData.modelContent?.inputMessages).toEqual(inputMessages);
    expect(events[1]?.privateData.modelContent?.systemPrompt).toBe("summarize accurately");
    expect(events[1]?.privateData.modelContent?.outputMessages).toEqual([assistant]);
  });

  it("closes the underlying iterator when result() completes before the consumer abandons it", async () => {
    // Mirrors packages/agent-core/src/agent-loop.ts: iterate, await result() on
    // the terminal event, then return (abandoning the iterator). The iterator's
    // return() carries provider cleanup (idle-timeout abort listeners, readers),
    // so it must still run even though result() emits the terminal event first.
    let returnCalled = false;
    const doneEvent = { type: "done", message: { role: "assistant", content: "ok" } };
    const stream = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          async next() {
            if (!emitted) {
              emitted = true;
              return { value: doneEvent, done: false };
            }
            return { value: undefined, done: true };
          },
          async return() {
            returnCalled = true;
            return { value: undefined, done: true };
          },
        };
      },
      result: async () => doneEvent.message,
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream) as unknown as StreamFn,
      {
        runId: "run-cleanup",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-cleanup",
      },
    );

    const events = await collectModelCallEvents(async () => {
      const response = wrapped({} as never, {} as never, {} as never) as unknown as typeof stream;
      for await (const event of response as AsyncIterable<{ type: string }>) {
        if (event.type === "done") {
          await (response as { result: () => Promise<unknown> }).result();
          break;
        }
      }
    });

    expect(returnCalled).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
  });

  it("propagates the trusted model-call traceparent without mutating caller headers", async () => {
    async function* stream() {
      yield { type: "text", text: "ok" };
    }
    const capturedOptions: Array<Parameters<StreamFn>[2]> = [];
    const callerOptions = {
      headers: {
        "X-Custom": "kept",
        TraceParent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      },
      sessionId: "provider-session",
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      ((
        _model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        capturedOptions.push(options);
        return stream();
      }) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
          traceFlags: "01",
        }),
        nextCallId: () => "call-traceparent",
      },
    );

    await drain(
      wrapped({} as never, {} as never, callerOptions) as unknown as AsyncIterable<unknown>,
    );

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]).not.toBe(callerOptions);
    const capturedOption = requireRecord(capturedOptions[0], "captured stream options");
    expect(capturedOption.sessionId).toBe("provider-session");
    const headers = readRecordField(capturedOption, "headers", "captured stream headers");
    expect(headers["X-Custom"]).toBe("kept");
    expect(typeof headers.traceparent).toBe("string");
    expect(headers.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    expect(capturedOptions[0]?.headers).not.toHaveProperty("TraceParent");
    expect(callerOptions.headers).toEqual({
      "X-Custom": "kept",
      TraceParent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    });
  });

  it("emits error events when stream iteration fails", async () => {
    const requestId = "req_provider_123";
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            throw new TypeError(`provider failed [request_id=${requestId}]`);
          },
        };
      },
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "anthropic",
        model: "sonnet-4.6",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-err",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await expect(
        drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>),
      ).rejects.toThrow("provider failed");
    });

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    const errorEvent = getEvent(events, 1);
    expect(errorEvent.type).toBe("model.call.error");
    expect(errorEvent.callId).toBe("call-err");
    expect(errorEvent.errorCategory).toBe("TypeError");
    expect(typeof errorEvent.upstreamRequestIdHash).toBe("string");
    expect(errorEvent.upstreamRequestIdHash).toMatch(/^sha256:[a-f0-9]{12}$/);
    expectNumberField(errorEvent, "durationMs");
    expect(JSON.stringify(events[1])).not.toContain(requestId);
  });

  it("adds failure kind and memory diagnostics for terminated model calls", async () => {
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            throw new Error("terminated");
          },
        };
      },
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "lmstudio",
        model: "qwen/qwen3.5-9b",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-terminated",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await expect(
        drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>),
      ).rejects.toThrow("terminated");
    });

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    const errorEvent = getEvent(events, 1);
    expect(errorEvent.type).toBe("model.call.error");
    expect(errorEvent.callId).toBe("call-terminated");
    expect(errorEvent.errorCategory).toBe("Error");
    expect(errorEvent.failureKind).toBe("terminated");
    const memory = readRecordField(errorEvent, "memory", "error event memory");
    expectNumberField(memory, "rssBytes");
    expectNumberField(memory, "heapTotalBytes");
    expectNumberField(memory, "heapUsedBytes");
    expectNumberField(memory, "externalBytes");
    expectNumberField(memory, "arrayBuffersBytes");
  });

  it("does not mutate non-configurable provider streams", async () => {
    const stream = {};
    Object.defineProperty(stream, Symbol.asyncIterator, {
      configurable: false,
      async *value() {
        yield { type: "text", text: "ok" };
      },
    });
    Object.freeze(stream);
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-frozen",
      },
    );

    const events = await collectModelCallEvents(async () => {
      const returned = wrapped(
        {} as never,
        {} as never,
        {} as never,
      ) as unknown as AsyncIterable<unknown>;
      expect(returned).not.toBe(stream);
      await drain(returned);
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
  });

  it("fires frozen sanitized model-call plugin hooks", async () => {
    const started = vi.fn();
    const ended = vi.fn();
    const { registry } = createHookRunnerWithRegistry([
      { hookName: "model_call_started", handler: started },
      { hookName: "model_call_ended", handler: ended },
    ]);
    initializeGlobalHookRunner(registry);
    const secretChunk = "secret response with Bearer sk-test-secret-value";

    async function* stream() {
      yield { type: "text", text: secretChunk };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "openai",
        model: "gpt-5.4",
        api: "openai-responses",
        transport: "http",
        contextTokenBudget: 150_000,
        contextWindowSource: "agentContextTokens",
        contextWindowReferenceTokens: 200_000,
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-hook",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    const startedEvent = requireMockRecordArg(started, 0, 0, "started hook event");
    expect(startedEvent.runId).toBe("run-1");
    expect(startedEvent.callId).toBe("call-hook");
    expect(startedEvent.sessionKey).toBe("session-key");
    expect(startedEvent.sessionId).toBe("session-id");
    expect(startedEvent.provider).toBe("openai");
    expect(startedEvent.model).toBe("gpt-5.4");
    expect(startedEvent.api).toBe("openai-responses");
    expect(startedEvent.transport).toBe("http");
    expect(startedEvent.contextTokenBudget).toBe(150_000);
    expect(startedEvent.contextWindowSource).toBe("agentContextTokens");
    expect(startedEvent.contextWindowReferenceTokens).toBe(200_000);
    const startedCtx = requireMockRecordArg(started, 0, 1, "started hook context");
    expect(startedCtx.runId).toBe("run-1");
    expect(startedCtx.sessionKey).toBe("session-key");
    expect(startedCtx.sessionId).toBe("session-id");
    expect(startedCtx.modelProviderId).toBe("openai");
    expect(startedCtx.modelId).toBe("gpt-5.4");
    expect(startedCtx.contextTokenBudget).toBe(150_000);
    expect(startedCtx.contextWindowSource).toBe("agentContextTokens");
    expect(startedCtx.contextWindowReferenceTokens).toBe(200_000);
    const endedEvent = requireMockRecordArg(ended, 0, 0, "ended hook event");
    expect(endedEvent.runId).toBe("run-1");
    expect(endedEvent.callId).toBe("call-hook");
    expect(endedEvent.outcome).toBe("completed");
    expect(endedEvent.contextTokenBudget).toBe(150_000);
    expect(endedEvent.contextWindowSource).toBe("agentContextTokens");
    expect(endedEvent.contextWindowReferenceTokens).toBe(200_000);
    expectNumberField(endedEvent, "durationMs");
    expectNumberField(endedEvent, "responseStreamBytes");
    expectNumberField(endedEvent, "timeToFirstByteMs");
    const endedCtx = requireMockRecordArg(ended, 0, 1, "ended hook context");
    expect(endedCtx.runId).toBe("run-1");
    expect(Object.isFrozen(startedEvent)).toBe(true);
    expect(Object.isFrozen(startedCtx)).toBe(true);
    expect(Object.isFrozen(startedCtx.trace)).toBe(true);
    expect(JSON.stringify([started.mock.calls, ended.mock.calls])).not.toContain(secretChunk);
  });

  it("emits completed events when stream consumption stops early", async () => {
    async function* stream() {
      yield { type: "text", text: "first" };
      yield { type: "text", text: "second" };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-abandoned",
      },
    );

    const events = await collectModelCallEvents(async () => {
      for await (const _ of wrapped(
        {} as never,
        {} as never,
        {} as never,
      ) as AsyncIterable<unknown>) {
        break;
      }
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.callId).toBe("call-abandoned");
    expectNumberField(completedEvent, "durationMs");
    expect(events[1]).not.toHaveProperty("errorCategory");
  });
});
