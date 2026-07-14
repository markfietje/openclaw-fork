import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession, SettingsManager } from "../../sessions/index.js";
import type { ComputerContextEpoch } from "../../tools/computer-tool.js";
import { installEmbeddedAttemptRuntimeGuards } from "./attempt-runtime-guards.js";
import type { AttemptContextEngine } from "./attempt.context-engine-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type TransformAgent = {
  transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>;
};

function createHarness(
  options: {
    activeContextEngine?: AttemptContextEngine;
    midTurnPrecheck?: boolean;
    prePromptMessageCount?: number;
    systemPrompt?: string;
  } = {},
) {
  const originalTransform = vi.fn(async (messages: AgentMessage[]) => messages);
  const agent: TransformAgent = { transformContext: originalTransform };
  const computerContextEpoch: ComputerContextEpoch = {
    value: 0,
    frameToolCallId: "computer-call",
    frameImageIdentity: "frame",
  };
  const attempt = {
    bootstrapContextRunKind: "default",
    config: options.midTurnPrecheck
      ? { agents: { defaults: { compaction: { midTurnPrecheck: { enabled: true } } } } }
      : {},
    contextTokenBudget: options.midTurnPrecheck ? 256 : 8_192,
    model: { contextWindow: 8_192, maxTokens: 4_096 },
    modelId: "test-model",
    provider: "test-provider",
    requestedModelId: "test-model",
    sessionFile: "/tmp/session.jsonl",
    sessionId: "session-1",
  } as unknown as EmbeddedRunAttemptParams;
  const settingsManager = {
    getBlockImages: () => true,
    getCompactionReserveTokens: () => 0,
  } as Pick<SettingsManager, "getBlockImages" | "getCompactionReserveTokens">;
  const guards = installEmbeddedAttemptRuntimeGuards({
    activeContextEngine: options.activeContextEngine,
    activeSession: { agent } as unknown as Pick<AgentSession, "agent">,
    agentDir: "/tmp/agent",
    attempt,
    computerContextEpoch,
    effectiveCwd: "/tmp/workspace",
    effectiveWorkspace: "/tmp/workspace",
    getEffectivePromptCacheRetention: () => "none",
    getPrePromptMessageCount: () => options.prePromptMessageCount ?? 1,
    getPromptCache: () => ({ retention: "none" }),
    getSystemPrompt: () => options.systemPrompt ?? "",
    isOpenAIResponsesApi: false,
    repairToolUseResultPairing: false,
    sessionAgentId: "agent-1",
    sessionManager: {} as ReturnType<typeof guardSessionManager>,
    settingsManager,
  });
  return { agent, computerContextEpoch, guards, originalTransform };
}

async function transform(agent: TransformAgent, messages: AgentMessage[]) {
  if (!agent.transformContext) {
    throw new Error("missing transformContext");
  }
  return await agent.transformContext(messages, new AbortController().signal);
}

describe("installEmbeddedAttemptRuntimeGuards", () => {
  it("restores the original transform after layered guard cleanup", async () => {
    const { agent, computerContextEpoch, guards, originalTransform } = createHarness();

    await transform(agent, [{ role: "user", content: "hello", timestamp: 1 }]);
    expect(computerContextEpoch.frameToolCallId).toBeUndefined();
    expect(agent.transformContext).not.toBe(originalTransform);

    guards.cleanup();
    expect(agent.transformContext).toBe(originalTransform);
  });

  it("queues and consumes a mid-turn overflow request once", async () => {
    const { agent, guards } = createHarness({
      midTurnPrecheck: true,
      systemPrompt: "system ".repeat(20_000),
    });
    const messages = [
      { role: "user", content: "go", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 2,
      },
    ] as AgentMessage[];

    await expect(transform(agent, messages)).rejects.toMatchObject({
      name: "MidTurnPrecheckSignal",
    });
    expect(guards.takePendingMidTurnPrecheckRequest()).toMatchObject({
      route: expect.not.stringMatching(/^fits$/u),
    });
    expect(guards.takePendingMidTurnPrecheckRequest()).toBeNull();
    guards.cleanup();
  });

  it("reports the context-engine checkpoint produced inside the tool loop", async () => {
    const afterTurn = vi.fn(async () => undefined);
    const activeContextEngine = {
      info: { id: "test-engine", ownsCompaction: true },
      afterTurn,
      assemble: vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({ messages })),
    } as unknown as AttemptContextEngine;
    const { agent, guards } = createHarness({
      activeContextEngine,
      prePromptMessageCount: 0,
    });

    await transform(agent, [{ role: "user", content: "hello", timestamp: 1 }]);
    expect(afterTurn).toHaveBeenCalledOnce();
    expect(guards.getContextEngineAfterTurnCheckpoint()).toBe(1);
    guards.cleanup();
  });
});
