import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type Model, type SimpleStreamOptions } from "../llm.js";
import type { AgentCoreRuntimeDeps } from "../runtime-deps.js";
import { CoreAgentHarness } from "./agent-harness.js";
import { InMemorySessionStorage } from "./session/memory-storage.js";
import { Session } from "./session/session.js";
import type { ExecutionEnv, SessionTreeEntry } from "./types.js";

const summaryModel: Model = {
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

describe("CoreAgentHarness branch summaries", () => {
  it("forwards branch-summary stream options through the harness wrapper", async () => {
    const entries: SessionTreeEntry[] = [
      {
        type: "message",
        id: "old-user",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "old prompt", timestamp: 1 },
      },
      {
        type: "message",
        id: "old-assistant",
        parentId: "old-user",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old answer" }],
          api: summaryModel.api,
          provider: summaryModel.provider,
          model: summaryModel.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "target-user",
        parentId: null,
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: "target prompt", timestamp: 3 },
      },
      {
        type: "leaf",
        id: "leaf-old",
        parentId: "target-user",
        timestamp: "2026-01-01T00:00:03.000Z",
        targetId: "old-assistant",
        appendParentId: "old-assistant",
      },
    ];
    let observedOptions: SimpleStreamOptions | undefined;
    const runtime: AgentCoreRuntimeDeps = {
      streamSimple: vi.fn((_model, _context, options) => {
        observedOptions = options;
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "branch summary" }],
            api: summaryModel.api,
            provider: summaryModel.provider,
            model: summaryModel.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 4,
          },
        });
        stream.end();
        return stream;
      }),
      completeSimple: vi.fn(async () => {
        throw new Error("branch summaries should use harness stream wrapper");
      }),
    };
    const harness = new CoreAgentHarness({
      env: { cwd: "/tmp/openclaw" } as ExecutionEnv,
      session: new Session(new InMemorySessionStorage({ entries })),
      model: summaryModel,
      runtime,
      getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
    });

    const result = await harness.navigateTree("target-user", { summarize: true });

    expect(result.cancelled).toBe(false);
    expect(runtime.streamSimple).toHaveBeenCalledOnce();
    expect(observedOptions?.maxTokens).toBe(2048);
    expect(observedOptions?.usageBudgetOperationId).toMatch(/^branch-summary:/);
  });
});
