// Plugin runtime index tests cover runtime entrypoint exports and registry setup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import {
  requestHeartbeat,
  resetHeartbeatWakeStateForTests,
  setHeartbeatWakeHandler,
} from "../../infra/heartbeat-wake.js";
import * as jsonFiles from "../../infra/json-files.js";
import * as execModule from "../../process/exec.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { VERSION } from "../../version.js";

const runtimeModelAuthMocks = vi.hoisted(() => ({
  getApiKeyForModel: vi.fn(),
  getRuntimeAuthForModel: vi.fn(),
  resolveApiKeyForProvider: vi.fn(),
}));

const ttsRuntimeMocks = vi.hoisted(() => ({
  textToSpeech: vi.fn(),
  textToSpeechStream: vi.fn(),
  textToSpeechTelephony: vi.fn(),
  listSpeechVoices: vi.fn(),
}));

const mediaUnderstandingRuntimeMocks = vi.hoisted(() => ({
  runMediaUnderstandingFile: vi.fn(),
  describeImageFile: vi.fn(),
  describeImageFileWithModel: vi.fn(),
  extractStructuredWithModel: vi.fn(),
  describeVideoFile: vi.fn(),
  transcribeAudioFile: vi.fn(),
}));

vi.mock("./runtime-model-auth.runtime.js", () => runtimeModelAuthMocks);
vi.mock("../../tts/tts.js", () => ttsRuntimeMocks);
vi.mock("../../media-understanding/runtime.js", () => mediaUnderstandingRuntimeMocks);

import {
  clearGatewaySubagentRuntime,
  createPluginRuntime,
  setGatewayNodesRuntime,
  setGatewaySubagentRuntime,
} from "./index.js";

function createCommandResult() {
  return {
    pid: 12345,
    stdout: "hello\n",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    noOutputTimedOut: false,
    termination: "exit" as const,
  };
}

function createGatewaySubagentRuntime() {
  return {
    run: vi.fn(),
    waitForRun: vi.fn(),
    getSessionMessages: vi.fn(),
    getSession: vi.fn(),
    deleteSession: vi.fn(),
  };
}

function expectRuntimeShape(
  assertRuntime: (runtime: ReturnType<typeof createPluginRuntime>) => void,
) {
  const runtime = createPluginRuntime();
  assertRuntime(runtime);
}

function expectGatewaySubagentRunFailure(
  runtime: ReturnType<typeof createPluginRuntime>,
  params: { sessionKey: string; message: string },
) {
  expect(() => runtime.subagent.run(params)).toThrow(
    "Plugin runtime subagent methods are only available during a gateway request.",
  );
}

function expectRuntimeValue<T>(
  readValue: (runtime: ReturnType<typeof createPluginRuntime>) => T,
  expected: T,
) {
  expect(readValue(createPluginRuntime())).toBe(expected);
}

function expectRuntimeSubagentRun(
  runtime: ReturnType<typeof createPluginRuntime>,
  params: { sessionKey: string; message: string },
) {
  return runtime.subagent.run(params);
}

function createGatewaySubagentRunFixture(params?: { allowGatewaySubagentBinding?: boolean }) {
  const run = vi.fn().mockResolvedValue({ runId: "run-1" });
  const runtime = params?.allowGatewaySubagentBinding
    ? createPluginRuntime({ allowGatewaySubagentBinding: true })
    : createPluginRuntime();

  setGatewaySubagentRuntime({
    ...createGatewaySubagentRuntime(),
    run,
  });

  return { run, runtime };
}

function expectFunctionKeys(value: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    expect(typeof value[key]).toBe("function");
  }
}

function expectRunCommandOutcome(params: {
  runtime: ReturnType<typeof createPluginRuntime>;
  expected: "resolve" | "reject";
  commandResult: ReturnType<typeof createCommandResult>;
}) {
  const command = params.runtime.system.runCommandWithTimeout(["echo", "hello"], {
    timeoutMs: 1000,
  });
  if (params.expected === "resolve") {
    return expect(command).resolves.toEqual(params.commandResult);
  }
  return expect(command).rejects.toThrow("boom");
}

describe("plugin runtime command execution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    runtimeModelAuthMocks.getApiKeyForModel.mockReset();
    runtimeModelAuthMocks.getRuntimeAuthForModel.mockReset();
    runtimeModelAuthMocks.resolveApiKeyForProvider.mockReset();
    ttsRuntimeMocks.textToSpeech.mockReset();
    ttsRuntimeMocks.textToSpeechStream.mockReset();
    ttsRuntimeMocks.textToSpeechTelephony.mockReset();
    ttsRuntimeMocks.listSpeechVoices.mockReset();
    mediaUnderstandingRuntimeMocks.runMediaUnderstandingFile.mockReset();
    mediaUnderstandingRuntimeMocks.describeImageFile.mockReset();
    mediaUnderstandingRuntimeMocks.describeImageFileWithModel.mockReset();
    mediaUnderstandingRuntimeMocks.extractStructuredWithModel.mockReset();
    mediaUnderstandingRuntimeMocks.describeVideoFile.mockReset();
    mediaUnderstandingRuntimeMocks.transcribeAudioFile.mockReset();
    resetConfigRuntimeState();
    clearGatewaySubagentRuntime();
  });

  it.each([
    {
      name: "exposes runtime.system.runCommandWithTimeout by default",
      mockKind: "resolve" as const,
      expected: "resolve" as const,
    },
    {
      name: "forwards runtime.system.runCommandWithTimeout errors",
      mockKind: "reject" as const,
      expected: "reject" as const,
    },
  ] as const)("$name", async ({ mockKind, expected }) => {
    const commandResult = createCommandResult();
    const runCommandWithTimeoutMock = vi.spyOn(execModule, "runCommandWithTimeout");
    if (mockKind === "resolve") {
      runCommandWithTimeoutMock.mockResolvedValue(commandResult);
    } else {
      runCommandWithTimeoutMock.mockRejectedValue(new Error("boom"));
    }

    const runtime = createPluginRuntime();
    await expectRunCommandOutcome({ runtime, expected, commandResult });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["echo", "hello"], { timeoutMs: 1000 });
  });

  it.each([
    {
      name: "exposes runtime.events.onAgentEvent",
      readValue: (runtime: ReturnType<typeof createPluginRuntime>) => runtime.events.onAgentEvent,
      expected: onAgentEvent,
    },
    {
      name: "exposes runtime.events.onSessionTranscriptUpdate",
      readValue: (runtime: ReturnType<typeof createPluginRuntime>) =>
        runtime.events.onSessionTranscriptUpdate,
      expected: onSessionTranscriptUpdate,
    },
    {
      name: "exposes runtime.system.requestHeartbeat",
      readValue: (runtime: ReturnType<typeof createPluginRuntime>) =>
        runtime.system.requestHeartbeat,
      expected: requestHeartbeat,
    },
    {
      name: "exposes deprecated runtime.system.requestHeartbeatNow",
      readValue: (runtime: ReturnType<typeof createPluginRuntime>) =>
        typeof runtime.system.requestHeartbeatNow,
      expected: "function",
    },
    {
      name: "exposes runtime.version from the shared VERSION constant",
      readValue: (runtime: ReturnType<typeof createPluginRuntime>) => runtime.version,
      expected: VERSION,
    },
  ] as const)("$name", ({ readValue, expected }) => {
    expectRuntimeValue(readValue, expected);
  });

  it("exposes reset freshness resolver on the host channel runtime", () => {
    const sessionRuntime = createPluginRuntime().channel.session as Record<string, unknown>;
    expect(typeof sessionRuntime.resolveEntryResetFreshness).toBe("function");
  });

  it("maps deprecated runtime.system.requestHeartbeatNow to an immediate compatibility wake", async () => {
    vi.useFakeTimers();
    resetHeartbeatWakeStateForTests();
    const handler = vi.fn(async (_request: Parameters<typeof requestHeartbeat>[0]) => ({
      status: "skipped" as const,
      reason: "disabled",
    }));
    setHeartbeatWakeHandler(handler);
    try {
      createPluginRuntime().system.requestHeartbeatNow({
        reason: "legacy-plugin",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
      const request = handler.mock.calls[0]?.[0] as
        | { source?: string; intent?: string; reason?: string }
        | undefined;
      expect(request?.source).toBe("other");
      expect(request?.intent).toBe("immediate");
      expect(request?.reason).toBe("legacy-plugin");
    } finally {
      resetHeartbeatWakeStateForTests();
      vi.useRealTimers();
    }
  });

  it("resolves thinking policy with configured model compat from runtime config", () => {
    setRuntimeConfigSnapshot({
      models: {
        providers: {
          gmn: {
            baseUrl: "https://gmn.example.com/v1",
            models: [
              {
                id: "gpt-5.4",
                name: "GPT 5.4 via GMN",
                reasoning: true,
                compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig);

    const runtime = createPluginRuntime();
    const policy = runtime.agent.resolveThinkingPolicy({
      provider: "gmn",
      model: "gpt-5.4",
    });

    expect(policy.levels.map((level) => level.id)).toContain("xhigh");
  });

  it.each([
    {
      name: "exposes runtime.mediaUnderstanding helpers and keeps stt as an alias",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.mediaUnderstanding as Record<string, unknown>, [
          "runFile",
          "describeImageFile",
          "describeImageFileWithModel",
          "extractStructuredWithModel",
          "describeVideoFile",
        ]);
        expect(runtime.mediaUnderstanding.transcribeAudioFile).toBe(
          runtime.stt.transcribeAudioFile,
        );
      },
    },
    {
      name: "exposes runtime.imageGeneration helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.imageGeneration as Record<string, unknown>, [
          "generate",
          "listProviders",
        ]);
      },
    },
    {
      name: "exposes runtime.webSearch helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.webSearch as Record<string, unknown>, [
          "listProviders",
          "search",
        ]);
      },
    },
    {
      name: "exposes canonical runtime.tasks task runtimes while keeping legacy TaskFlow aliases",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.tasks.runs as Record<string, unknown>, [
          "bindSession",
          "fromToolContext",
        ]);
        expectFunctionKeys(runtime.tasks.flows as Record<string, unknown>, [
          "bindSession",
          "fromToolContext",
        ]);
        expectFunctionKeys(runtime.tasks.managedFlows as Record<string, unknown>, [
          "bindSession",
          "fromToolContext",
        ]);
        expectFunctionKeys(runtime.tasks.flow as Record<string, unknown>, [
          "bindSession",
          "fromToolContext",
        ]);
        expect(runtime.tasks.managedFlows).toBe(runtime.tasks.flow);
        expect(runtime.taskFlow).toBe(runtime.tasks.managedFlows);
      },
    },
    {
      name: "exposes runtime.agent host helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expect(runtime.agent.defaults).toEqual({
          model: DEFAULT_MODEL,
          provider: DEFAULT_PROVIDER,
        });
        expectFunctionKeys(runtime.agent as Record<string, unknown>, [
          "runEmbeddedAgent",
          "runEmbeddedPiAgent",
          "normalizeThinkingLevel",
          "resolveThinkingPolicy",
          "resolveAgentDir",
        ]);
        expect(runtime.agent.runEmbeddedPiAgent).toBe(runtime.agent.runEmbeddedAgent);
        expectFunctionKeys(runtime.agent.session as Record<string, unknown>, [
          "loadSessionStore",
          "getSessionEntry",
          "listSessionEntries",
          "patchSessionEntry",
          "upsertSessionEntry",
          "saveSessionStore",
          "updateSessionStore",
          "updateSessionStoreEntry",
          "resolveSessionFilePath",
        ]);
      },
    },
    {
      name: "exposes runtime.modelAuth with raw and runtime-ready auth helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.modelAuth, [
          "getApiKeyForModel",
          "getRuntimeAuthForModel",
          "resolveApiKeyForProvider",
        ]);
      },
    },
  ] as const)("$name", ({ assert }) => {
    expectRuntimeShape(assert);
  });

  it("rejects plugin media-understanding provider calls while agent usage budgets are enabled", async () => {
    const runtime = createPluginRuntime();
    const cfg = {
      agents: {
        defaults: {
          usageBudget: { daily: { tokens: 1_000 } },
        },
      },
    } satisfies OpenClawConfig;

    await expect(
      runtime.mediaUnderstanding.transcribeAudioFile({
        filePath: "/tmp/input.wav",
        cfg,
        agentId: "budgeted-agent",
      }),
    ).rejects.toThrow("Plugin runtime media provider calls are unavailable");

    expect(mediaUnderstandingRuntimeMocks.transcribeAudioFile).not.toHaveBeenCalled();
  });

  it("rejects plugin generation provider calls while agent usage budgets are enabled", async () => {
    const runtime = createPluginRuntime();
    const cfg = {
      agents: {
        defaults: {
          usageBudget: { daily: { usd: 1 } },
        },
      },
    } satisfies OpenClawConfig;

    await expect(
      runtime.imageGeneration.generate({
        cfg,
        agentId: "budgeted-agent",
        prompt: "diagram",
      }),
    ).rejects.toThrow("Plugin runtime media provider calls are unavailable");
  });

  it("returns plugin TTS failures while agent usage budgets are enabled", async () => {
    const runtime = createPluginRuntime();
    const cfg = {
      agents: {
        defaults: {
          usageBudget: { monthly: { tokens: 10_000 } },
        },
      },
    } satisfies OpenClawConfig;

    const fileResult = await runtime.tts.textToSpeech({
      text: "hello",
      cfg,
      agentId: "budgeted-agent",
    });
    const streamResult = await runtime.tts.textToSpeechStream({
      text: "hello",
      cfg,
      agentId: "budgeted-agent",
    });
    const telephonyResult = await runtime.tts.textToSpeechTelephony({
      text: "hello",
      cfg,
      agentId: "budgeted-agent",
    });

    expect(fileResult).toEqual({
      success: false,
      error: expect.stringContaining("Plugin runtime TTS provider calls are unavailable"),
    });
    expect(streamResult).toEqual({
      success: false,
      error: expect.stringContaining("Plugin runtime TTS provider calls are unavailable"),
    });
    expect(telephonyResult).toEqual({
      success: false,
      error: expect.stringContaining("Plugin runtime TTS provider calls are unavailable"),
    });
    expect(ttsRuntimeMocks.textToSpeech).not.toHaveBeenCalled();
    expect(ttsRuntimeMocks.textToSpeechStream).not.toHaveBeenCalled();
    expect(ttsRuntimeMocks.textToSpeechTelephony).not.toHaveBeenCalled();
  });

  it("uses runtime config to reject unattributed plugin TTS calls", async () => {
    setRuntimeConfigSnapshot({
      agents: {
        list: [
          {
            id: "ops",
            usageBudget: { daily: { tokens: 1_000 } },
          },
        ],
      },
    } satisfies OpenClawConfig);
    const runtime = createPluginRuntime();

    const result = await runtime.tts.textToSpeech({ text: "hello" });

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Plugin runtime TTS provider calls are unavailable"),
    });
    expect(ttsRuntimeMocks.textToSpeech).not.toHaveBeenCalled();
  });

  it("rejects unattributed plugin provider calls when any agent usage budget is configured", async () => {
    const runtime = createPluginRuntime();
    const cfg = {
      agents: {
        list: [
          {
            id: "ops",
            usageBudget: { daily: { tokens: 1_000 } },
          },
        ],
      },
    } satisfies OpenClawConfig;

    await expect(
      runtime.mediaUnderstanding.describeImageFile({
        filePath: "/tmp/input.png",
        cfg,
      }),
    ).rejects.toThrow("Plugin runtime media provider calls are unavailable");
    await expect(
      runtime.imageGeneration.generate({
        cfg,
        prompt: "diagram",
      }),
    ).rejects.toThrow("Plugin runtime media provider calls are unavailable");
    const ttsResult = await runtime.tts.textToSpeech({
      text: "hello",
      cfg,
    });

    expect(ttsResult).toEqual({
      success: false,
      error: expect.stringContaining("Plugin runtime TTS provider calls are unavailable"),
    });
    expect(mediaUnderstandingRuntimeMocks.describeImageFile).not.toHaveBeenCalled();
    expect(ttsRuntimeMocks.textToSpeech).not.toHaveBeenCalled();
  });

  it("preserves requireWriteSuccess through runtime session entry updates", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-session-store-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const runtime = createPluginRuntime();

    try {
      await runtime.agent.session.upsertSessionEntry({
        sessionKey,
        storePath,
        entry: {
          sessionId: "session-1",
          updatedAt: 10,
        },
      });
      const writeError = Object.assign(new Error("write failed"), { code: "ENOENT" });
      const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic").mockRejectedValue(writeError);

      try {
        await expect(
          runtime.agent.session.updateSessionStoreEntry({
            sessionKey,
            storePath,
            requireWriteSuccess: true,
            update: () => ({ model: "gpt-5.5" }),
          }),
        ).rejects.toBe(writeError);
      } finally {
        writeSpy.mockRestore();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("modelAuth wrappers strip agentDir and store to prevent credential steering", async () => {
    // The wrappers should not forward agentDir or store from plugin callers.
    // We verify this by checking the wrapper functions exist and are not the
    // raw implementations (they are wrapped, not direct references).
    const { getApiKeyForModel: rawGetApiKey } = await import("../../agents/model-auth.js");
    const runtime = createPluginRuntime();
    // Wrappers should NOT be the same reference as the raw functions
    expect(runtime.modelAuth.getApiKeyForModel).not.toBe(rawGetApiKey);
  });

  it("modelAuth wrappers preserve workspace scope while stripping credential steering", async () => {
    const runtime = createPluginRuntime();
    const model = {
      id: "workspace-cloud/model",
      provider: "workspace-cloud",
      api: "openai-responses",
      baseUrl: "https://workspace-cloud.example/v1",
    };
    const cfg = { plugins: { allow: ["workspace-cloud"] } } as OpenClawConfig;
    runtimeModelAuthMocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "model-key",
      source: "workspace cloud credentials",
      mode: "api-key",
    });
    runtimeModelAuthMocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "provider-key",
      source: "workspace cloud credentials",
      mode: "api-key",
    });

    const modelAuth = await runtime.modelAuth.getApiKeyForModel({
      model: model as never,
      cfg,
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      store: { version: 1, profiles: {} },
    } as never);
    expect(modelAuth.apiKey).toBe("model-key");

    const providerAuth = await runtime.modelAuth.resolveApiKeyForProvider({
      provider: "workspace-cloud",
      cfg,
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      store: { version: 1, profiles: {} },
    } as never);
    expect(providerAuth.apiKey).toBe("provider-key");

    expect(runtimeModelAuthMocks.getApiKeyForModel).toHaveBeenCalledWith({
      model,
      cfg,
      workspaceDir: "/tmp/workspace",
    });
    expect(runtimeModelAuthMocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "workspace-cloud",
      cfg,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("keeps subagent unavailable by default even after gateway initialization", () => {
    const { runtime } = createGatewaySubagentRunFixture();

    expectGatewaySubagentRunFailure(runtime, { sessionKey: "s-1", message: "hello" });
  });

  it("late-binds to the gateway subagent when explicitly enabled", async () => {
    const { run, runtime } = createGatewaySubagentRunFixture({
      allowGatewaySubagentBinding: true,
    });

    await expect(
      expectRuntimeSubagentRun(runtime, { sessionKey: "s-2", message: "hello" }),
    ).resolves.toEqual({
      runId: "run-1",
    });
    expect(run).toHaveBeenCalledWith({ sessionKey: "s-2", message: "hello" });
  });

  it("uses explicit nodes runtime when provided", async () => {
    const nodes = {
      list: vi.fn().mockResolvedValue({ nodes: [] }),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };
    const runtime = createPluginRuntime({ nodes });

    await expect(runtime.nodes.list({ connected: true })).resolves.toEqual({ nodes: [] });
    await expect(
      runtime.nodes.invoke({ nodeId: "node-1", command: "browser.proxy" }),
    ).resolves.toEqual({ ok: true });
    expect(nodes.list).toHaveBeenCalledWith({ connected: true });
    expect(nodes.invoke).toHaveBeenCalledWith({ nodeId: "node-1", command: "browser.proxy" });
  });

  it("rejects unattributed plugin runtime node invocations while any agent usage budget is configured", async () => {
    setRuntimeConfigSnapshot({
      agents: {
        list: [
          {
            id: "ops",
            usageBudget: { daily: { tokens: 1_000 } },
          },
        ],
      },
    } satisfies OpenClawConfig);
    const nodes = {
      list: vi.fn().mockResolvedValue({ nodes: [{ nodeId: "node-1" }] }),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };
    const runtime = createPluginRuntime({ nodes });

    await expect(runtime.nodes.list({ connected: true })).resolves.toEqual({
      nodes: [{ nodeId: "node-1" }],
    });
    await expect(
      runtime.nodes.invoke({ nodeId: "node-1", command: "ollama.chat" }),
    ).rejects.toThrow("Plugin runtime node invocations are unavailable");
    expect(nodes.invoke).not.toHaveBeenCalled();
  });

  it("scopes plugin runtime node budget checks to the calling agent", async () => {
    const cfg = {
      agents: {
        defaults: {
          usageBudget: { daily: { tokens: 1_000 } },
        },
        list: [
          {
            id: "free",
            usageBudget: { enabled: false },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const nodes = {
      list: vi.fn().mockResolvedValue({ nodes: [{ nodeId: "node-1" }] }),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };
    const runtime = createPluginRuntime({ nodes });

    await expect(
      runtime.nodes.invoke({
        nodeId: "node-1",
        command: "device.status",
        cfg,
        agentId: "budgeted",
      }),
    ).rejects.toThrow("Plugin runtime node invocations are unavailable");
    await expect(
      runtime.nodes.invoke({
        nodeId: "node-1",
        command: "device.status",
        cfg,
        agentId: "free",
      }),
    ).resolves.toEqual({ ok: true });

    expect(nodes.invoke).toHaveBeenCalledTimes(1);
    expect(nodes.invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: "device.status",
    });
  });

  it("late-binds to gateway nodes when explicitly enabled", async () => {
    const nodes = {
      list: vi.fn().mockResolvedValue({ nodes: [{ nodeId: "node-1" }] }),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };
    const runtime = createPluginRuntime({ allowGatewaySubagentBinding: true });
    setGatewayNodesRuntime(nodes);

    await expect(runtime.nodes.list({ connected: true })).resolves.toEqual({
      nodes: [{ nodeId: "node-1" }],
    });
    expect(nodes.list).toHaveBeenCalledWith({ connected: true });
  });
});
