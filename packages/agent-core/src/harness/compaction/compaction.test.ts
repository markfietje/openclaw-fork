import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Context, Model, StreamFn } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import { convertToLlm, createCompactionSummaryMessage } from "../messages.js";
import { buildSessionContext } from "../session/session.js";
import type { SessionTreeEntry } from "../types.js";
import { compact, generateSummary, prepareCompaction } from "./compaction.js";
import { createFileOps } from "./utils.js";

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

function assistantMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
    timestamp,
  };
}

function userMessage(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function roomObservationMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
    provenance: { kind: "room_observation", sourceChannel: "slack" },
  } as unknown as AgentMessage;
}

function toolResultMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${timestamp}`,
    toolName: "message",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function messageEntry(message: AgentMessage, index: number): SessionTreeEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}

function contextText(context: Context): string {
  return context.messages
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    )
    .join("\n");
}

describe("generateSummary thinking options", () => {
  it("maps explicit Fable off to low effort for compaction", async () => {
    const summaryMessage = assistantMessage("summary", 1);
    const streamFn = vi.fn<StreamFn>((_model, context, options) => {
      expect(options?.reasoning).toBe("low");
      expect(context.systemPrompt).toContain("user and an AI assistant");
      expect(context.systemPrompt).not.toContain("AI coding assistant");
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
});

describe("split-turn compaction", () => {
  it("serializes history and turn-prefix summaries", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "test-api",
      provider: "test-provider",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
    };
    let active = 0;
    let maxActive = 0;
    let callCount = 0;
    const streamFn = vi.fn<StreamFn>(() => {
      active++;
      maxActive = Math.max(maxActive, active);
      callCount++;
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        active--;
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: `summary-${callCount}` }],
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
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      }, 5);
      return stream;
    });

    const result = await compact(
      {
        firstKeptEntryId: "kept-entry",
        messagesToSummarize: [{ role: "user", content: "history", timestamp: 1 }],
        turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: 2 }],
        isSplitTurn: true,
        tokensBefore: 100,
        fileOps: createFileOps(),
        settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
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
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });
});

describe("room-observation compaction", () => {
  it("excludes the entire observation turn before summary replay", async () => {
    const messages: AgentMessage[] = [
      userMessage("AUTHORIZED_OLD_GOAL", 1),
      assistantMessage("authorized old progress", 2),
      roomObservationMessage("OBSERVATION_DO_NOT_EXEC", 3),
      assistantMessage("ASSISTANT_ECHO_DO_NOT_EXEC", 4),
      toolResultMessage("TOOL_OUTPUT_DO_NOT_EXEC", 5),
      userMessage("AUTHORIZED_CURRENT_GOAL", 6),
      assistantMessage("authorized current progress", 7),
    ];
    const entries = messages.map(messageEntry);
    const preparationResult = prepareCompaction(entries, {
      enabled: true,
      reserveTokens: 1_000,
      keepRecentTokens: 1,
    });
    if (!preparationResult.ok || !preparationResult.value) {
      throw new Error("expected compaction preparation");
    }
    const preparation = preparationResult.value;

    expect(preparation.messagesToSummarize.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(preparation.turnPrefixMessages.map((message) => message.role)).toEqual(["user"]);

    const prompts: string[] = [];
    const streamFn = vi.fn<StreamFn>((_model, context) => {
      prompts.push(contextText(context));
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: assistantMessage("## Goal\nContinue only authorized work.", 8),
      });
      stream.end();
      return stream;
    });

    const compactionResult = await compact(
      preparation,
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );
    if (!compactionResult.ok) {
      throw compactionResult.error;
    }

    const summarizerInput = prompts.join("\n");
    expect(summarizerInput).toContain("AUTHORIZED_OLD_GOAL");
    expect(summarizerInput).toContain("AUTHORIZED_CURRENT_GOAL");
    expect(summarizerInput).not.toContain("OBSERVATION_DO_NOT_EXEC");
    expect(summarizerInput).not.toContain("ASSISTANT_ECHO_DO_NOT_EXEC");
    expect(summarizerInput).not.toContain("TOOL_OUTPUT_DO_NOT_EXEC");

    const replayed = convertToLlm([
      createCompactionSummaryMessage(
        compactionResult.value.summary,
        compactionResult.value.tokensBefore,
        new Date(9).toISOString(),
      ),
    ]);
    const replayText = contextText({ systemPrompt: "", messages: replayed });
    expect(replayText).toContain("Continue only authorized work.");
    expect(replayText).not.toContain("OBSERVATION_DO_NOT_EXEC");
    expect(replayText).not.toContain("ASSISTANT_ECHO_DO_NOT_EXEC");
    expect(replayText).not.toContain("TOOL_OUTPUT_DO_NOT_EXEC");
  });

  it("retains the provenance-bearing user row when a cut would split an observation turn", () => {
    const entries: SessionTreeEntry[] = [
      messageEntry(userMessage("authorized history", 1), 0),
      messageEntry(assistantMessage("authorized progress", 2), 1),
      messageEntry(roomObservationMessage("passive observation", 3), 2),
      {
        type: "custom_message",
        id: "entry-3",
        parentId: "entry-2",
        timestamp: new Date(4).toISOString(),
        customType: "observation-note",
        content: "custom observation context",
        display: false,
      },
      messageEntry(assistantMessage("private observation analysis", 5), 4),
      messageEntry(toolResultMessage("same-channel comment result", 6), 5),
    ];
    const preparationResult = prepareCompaction(entries, {
      enabled: true,
      reserveTokens: 1_000,
      keepRecentTokens: 1,
    });
    if (!preparationResult.ok || !preparationResult.value) {
      throw new Error("expected compaction preparation");
    }
    const preparation = preparationResult.value;

    expect(preparation.firstKeptEntryId).toBe("entry-2");
    expect(preparation.isSplitTurn).toBe(false);
    expect(preparation.turnPrefixMessages).toEqual([]);
    expect(preparation.messagesToSummarize.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);

    const compactionEntry: SessionTreeEntry = {
      type: "compaction",
      id: "entry-6",
      parentId: "entry-5",
      timestamp: new Date(7).toISOString(),
      summary: "authorized history summary",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    };
    const replayContext = buildSessionContext([...entries, compactionEntry]);
    const retainedObservation = replayContext.messages.find(
      (message) => message.role === "user" && "provenance" in message,
    ) as (AgentMessage & { provenance?: { kind?: string } }) | undefined;

    expect(retainedObservation?.provenance?.kind).toBe("room_observation");
  });

  it("refuses to cross a prior compaction when a legacy retained suffix has no user boundary", () => {
    const entries: SessionTreeEntry[] = [
      messageEntry(roomObservationMessage("legacy passive observation", 1), 0),
      {
        type: "custom_message",
        id: "entry-1",
        parentId: "entry-0",
        timestamp: new Date(2).toISOString(),
        customType: "observation-note",
        content: "legacy custom observation context",
        display: false,
      },
      messageEntry(assistantMessage("legacy private analysis", 3), 2),
      {
        type: "compaction",
        id: "entry-3",
        parentId: "entry-2",
        timestamp: new Date(4).toISOString(),
        summary: "safe prior summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
      {
        type: "custom_message",
        id: "entry-4",
        parentId: "entry-3",
        timestamp: new Date(5).toISOString(),
        customType: "observation-note",
        content: "continued observation context",
        display: false,
      },
      messageEntry(assistantMessage("continued private analysis", 6), 5),
      messageEntry(toolResultMessage("continued same-channel result", 7), 6),
    ];

    const preparationResult = prepareCompaction(entries, {
      enabled: true,
      reserveTokens: 1_000,
      keepRecentTokens: 1,
    });

    expect(preparationResult.ok).toBe(false);
    if (!preparationResult.ok) {
      expect(preparationResult.error.message).toContain(
        "without a provenance-bearing user boundary",
      );
    }
  });
});
