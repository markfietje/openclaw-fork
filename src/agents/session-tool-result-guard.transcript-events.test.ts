// Verifies guarded session managers emit transcript update events with stable sequence ids.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

const listeners: Array<() => void> = [];

afterEach(() => {
  // Remove all transcript listeners between tests to avoid duplicate broadcasts.
  while (listeners.length > 0) {
    listeners.pop()?.();
  }
});

describe("guardSessionManager transcript updates", () => {
  it("includes the session key when broadcasting appended non-tool-result messages", () => {
    const updates: SessionTranscriptUpdate[] = [];
    listeners.push(onSessionTranscriptUpdate((update) => updates.push(update)));

    const sm = SessionManager.inMemory();
    const sessionFile = "/tmp/openclaw-session-message-events.jsonl";
    Object.assign(sm, {
      getSessionFile: () => sessionFile,
    });

    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:worker",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    const timestamp = Date.now();
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello from subagent" }],
      timestamp,
    } as AgentMessage);

    expect(updates).toStrictEqual([
      {
        agentId: "main",
        message: {
          content: [{ text: "hello from subagent", type: "text" }],
          role: "assistant",
          timestamp,
        },
        messageId: expect.any(String),
        messageSeq: 1,
        sessionFile,
        sessionKey: "agent:main:worker",
      },
    ]);
    expect(updates[0]?.messageId).not.toBe("");
  });

  it("does not resolve transcript sequence when no session file is available", () => {
    const sm = SessionManager.inMemory();
    Object.assign(sm, {
      getSessionFile: () => undefined,
    });
    const getBranchSpy = vi.spyOn(sm, "getBranch");

    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:worker",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(getBranchSpy).not.toHaveBeenCalled();
    getBranchSpy.mockRestore();
  });

  it("reuses cached transcript sequence for consecutive appended messages", () => {
    const updates: SessionTranscriptUpdate[] = [];
    listeners.push(onSessionTranscriptUpdate((update) => updates.push(update)));

    const sm = SessionManager.inMemory();
    sm.appendMessage({
      role: "user",
      content: "existing prompt",
      timestamp: Date.now(),
    } as Parameters<typeof sm.appendMessage>[0]);
    const getBranchSpy = vi.spyOn(sm, "getBranch");
    const sessionFile = "/tmp/openclaw-session-message-events.jsonl";
    Object.assign(sm, {
      getSessionFile: () => sessionFile,
    });

    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:worker",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first" }],
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(getBranchSpy).toHaveBeenCalledTimes(1);
    expect(updates.map((update) => update.messageSeq)).toEqual([2, 3]);
    getBranchSpy.mockRestore();
  });

  it("caches real tool result sequence before final assistant messages", () => {
    // Tool results are persisted but not broadcast, so later visible messages must skip their seq.
    const updates: SessionTranscriptUpdate[] = [];
    listeners.push(onSessionTranscriptUpdate((update) => updates.push(update)));

    const sm = SessionManager.inMemory();
    sm.appendMessage({
      role: "user",
      content: "existing prompt",
      timestamp: Date.now(),
    } as Parameters<typeof sm.appendMessage>[0]);
    const getBranchSpy = vi.spyOn(sm, "getBranch");
    const sessionFile = "/tmp/openclaw-session-message-events.jsonl";
    Object.assign(sm, {
      getSessionFile: () => sessionFile,
    });

    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:worker",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "tool output" }],
      isError: false,
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(getBranchSpy).toHaveBeenCalledTimes(1);
    expect(updates.map((update) => update.messageSeq)).toEqual([2, 4]);
    getBranchSpy.mockRestore();
  });

  it("keeps detached passive appends private while publishing the approved canonical user turn", async () => {
    const updates: SessionTranscriptUpdate[] = [];
    listeners.push(onSessionTranscriptUpdate((update) => updates.push(update)));
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-passive-events-"));
    try {
      const sessionKey = "agent:main:slack:channel:C123";
      const detachedSessionFile = path.join(tempDir, "detached-passive.jsonl");
      const canonicalSessionFile = path.join(tempDir, "canonical.jsonl");
      const sm = SessionManager.inMemory();
      Object.assign(sm, {
        getSessionFile: () => detachedSessionFile,
      });
      const guarded = guardSessionManager(sm, {
        agentId: "main",
        sessionKey,
        suppressTranscriptUpdates: true,
      });
      const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
        message: AgentMessage,
      ) => void;

      appendMessage({
        role: "user",
        content: "untrusted room event",
        timestamp: 1,
      } as AgentMessage);
      appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "message", arguments: {} }],
        timestamp: 2,
      } as AgentMessage);
      appendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "message",
        content: [{ type: "text", text: "sent" }],
        isError: false,
        timestamp: 3,
      } as AgentMessage);
      appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "private passive analysis" }],
        timestamp: 4,
      } as AgentMessage);

      expect(updates).toEqual([]);

      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "approved canonical room event", timestamp: 5 },
        target: {
          transcriptPath: canonicalSessionFile,
          sessionId: "canonical-session",
          sessionKey,
          agentId: "main",
          cwd: tempDir,
        },
        updateMode: "inline",
      });
      await recorder.persistApproved();

      expect(updates).toStrictEqual([
        expect.objectContaining({
          agentId: "main",
          sessionFile: canonicalSessionFile,
          sessionKey,
          message: expect.objectContaining({
            role: "user",
            content: "approved canonical room event",
          }),
          messageId: expect.any(String),
        }),
      ]);
      expect(updates[0]?.sessionFile).not.toBe(detachedSessionFile);
      expect(updates[0]?.messageSeq).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
