// Coverage for handing replay-safe plugin-harness prompt timeouts to model fallback.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { AgentUsageBudgetError } from "../usage-budget.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  MockedFailoverError,
  mockedClassifyFailoverReason,
  mockedCompactDirect,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent prompt timeout fallback handoff", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("throws FailoverError for replay-safe harness-owned prompt timeouts when model fallbacks are configured", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        promptError: new Error("LLM request timed out."),
        promptErrorSource: "prompt",
      }),
    );

    const promise = runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-prompt-timeout-fallback",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("LLM request timed out.");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("surfaces replay-invalid prompt timeouts instead of handing them to model fallback", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        promptError: new Error("LLM request timed out."),
        promptErrorSource: "prompt",
        promptTimeoutOutcome: {
          message: "Harness abandoned the timed-out turn after provider activity.",
          replayInvalid: true,
          livenessState: "abandoned",
        },
      }),
    );

    let thrown: unknown;
    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.4",
        runId: "run-prompt-timeout-replay-invalid",
        config: makeModelFallbackCfg({
          agents: {
            defaults: {
              model: {
                primary: "openai/gpt-5.4",
                fallbacks: ["anthropic/claude-opus-4-6"],
              },
            },
          },
        }),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(MockedFailoverError);
    expect(String((thrown as Error | undefined)?.message)).toContain("LLM request timed out.");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("surfaces usage-budget denials instead of handing them to model fallback", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        promptError: new Error(
          'Usage budget blocked for agent "main": daily token budget is exhausted (100/100 tokens, resets 2026-07-16T00:00:00.000Z).',
        ),
        promptErrorSource: "budget",
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-usage-budget-blocked",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedClassifyFailoverReason).not.toHaveBeenCalled();
    expect(result.payloads).toEqual([
      {
        text: "This agent's usage budget is currently blocking model calls. Ask an operator to review the budget before retrying.",
        isError: true,
      },
    ]);
    expect(result.meta.finalAssistantVisibleText).toBe(
      "This agent's usage budget is currently blocking model calls. Ask an operator to review the budget before retrying.",
    );
    expect(result.meta.error).toEqual({
      kind: "usage_budget",
      message:
        'Usage budget blocked for agent "main": daily token budget is exhausted (100/100 tokens, resets 2026-07-16T00:00:00.000Z).',
    });
    expect(result.meta.livenessState).toBe("blocked");
  });

  it("surfaces usage-budget denials from overflow compaction instead of context reset advice", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        promptError: new Error("request_too_large: Request size exceeds model context window"),
      }),
    );
    mockedCompactDirect.mockRejectedValueOnce(
      new AgentUsageBudgetError(
        'Usage budget blocked for agent "main": daily token budget is exhausted (100/100 tokens, resets 2026-07-16T00:00:00.000Z).',
        {
          agentId: "main",
          provider: "openai",
          model: "gpt-5.4",
          reason: "exceeded",
          window: "daily",
          limitKind: "tokens",
          used: 100,
          limit: 100,
          resetAt: "2026-07-16T00:00:00.000Z",
        },
      ),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-overflow-compaction-usage-budget-blocked",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      {
        text: "This agent's usage budget is currently blocking model calls. Ask an operator to review the budget before retrying.",
        isError: true,
      },
    ]);
    expect(result.meta.finalAssistantVisibleText).toBe(
      "This agent's usage budget is currently blocking model calls. Ask an operator to review the budget before retrying.",
    );
    expect(result.meta.error).toEqual({
      kind: "usage_budget",
      message:
        'Usage budget blocked for agent "main": daily token budget is exhausted (100/100 tokens, resets 2026-07-16T00:00:00.000Z).',
    });
    expect(result.meta.livenessState).toBe("blocked");
  });
});
