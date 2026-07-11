// Configured Crestodian assistant tests cover config-driven assistant behavior.
import { describe, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import { planCrestodianCommand, planCrestodianCommandWithConfiguredModel } from "./assistant.js";

describe("Crestodian configured-model planner", () => {
  function createConfiguredModel(): Model<"openai-responses"> {
    return {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 1024,
    };
  }

  const overview = {
    config: {
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      hash: "hash",
    },
    agents: [],
    defaultAgentId: "main",
    tools: {
      codex: { command: "codex", found: false },
      claude: { command: "claude", found: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: {
      url: "ws://127.0.0.1:18789",
      source: "local loopback",
      reachable: false,
    },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  };

  it("skips the configured model path when no config file exists", async () => {
    const readConfigFileSnapshot = vi.fn(async () => ({
      path: "/tmp/openclaw.json",
      exists: false,
      raw: null,
      parsed: {},
      sourceConfig: {},
      resolved: {},
      valid: true,
      runtimeConfig: {},
      config: {},
      issues: [],
      legacyIssues: [],
      warnings: [],
    }));
    const prepareSimpleCompletionModelForAgent = vi.fn();

    await expect(
      planCrestodianCommandWithConfiguredModel({
        input: "please set up my model",
        overview: { ...overview, config: { ...overview.config, exists: false, hash: null } },
        deps: {
          readConfigFileSnapshot,
          prepareSimpleCompletionModelForAgent,
        },
      }),
    ).resolves.toBeNull();

    expect(prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("passes usage budget context to configured model planning", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          usageBudget: { daily: { tokens: 100 } },
        },
      },
    };
    const readConfigFileSnapshot = vi.fn(async () => ({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: null,
      parsed: {},
      sourceConfig: cfg,
      resolved: cfg,
      runtimeConfig: cfg,
      config: cfg,
      valid: true,
      issues: [],
      legacyIssues: [],
      warnings: [],
    }));
    const prepareSimpleCompletionModelForAgent = vi.fn(async () => ({
      selection: {
        provider: "openai",
        modelId: "gpt-5.5",
        agentDir: "/tmp/openclaw-agent",
      },
      model: createConfiguredModel(),
      auth: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
        mode: "api-key" as const,
      },
    }));
    const completeWithPreparedSimpleCompletionModel = vi.fn(async () => ({
      content: [{ type: "text", text: '{"command":"models"}' }],
    }));

    const result = await planCrestodianCommandWithConfiguredModel({
      input: "show me models",
      overview,
      deps: {
        readConfigFileSnapshot,
        prepareSimpleCompletionModelForAgent,
        completeWithPreparedSimpleCompletionModel:
          completeWithPreparedSimpleCompletionModel as never,
      },
    });

    expect(result).toEqual({ command: "models", modelLabel: "openai/gpt-5.5" });
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        usageBudget: {
          config: cfg,
          agentId: "main",
          provider: "openai",
          model: "gpt-5.5",
          recordIdPrefix: "crestodian-assistant",
        },
      }),
    );
  });

  it("does not fall back to local planners after a usage budget denial", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          usageBudget: { daily: { tokens: 100 } },
        },
      },
    };
    const readConfigFileSnapshot = vi.fn(async () => ({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: null,
      parsed: {},
      sourceConfig: cfg,
      resolved: cfg,
      runtimeConfig: cfg,
      config: cfg,
      valid: true,
      issues: [],
      legacyIssues: [],
      warnings: [],
    }));
    const prepareSimpleCompletionModelForAgent = vi.fn(async () => ({
      selection: {
        provider: "openai",
        modelId: "gpt-5.5",
        agentDir: "/tmp/openclaw-agent",
      },
      model: createConfiguredModel(),
      auth: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
        mode: "api-key" as const,
      },
    }));
    const budgetError = Object.assign(new Error("budget exhausted"), {
      code: "agent_usage_budget_blocked",
    });
    const completeWithPreparedSimpleCompletionModel = vi.fn(async () => {
      throw budgetError;
    });
    const runCliAgent = vi.fn();
    const runEmbeddedAgent = vi.fn();

    await expect(
      planCrestodianCommand({
        input: "show me models",
        overview,
        deps: {
          readConfigFileSnapshot,
          prepareSimpleCompletionModelForAgent,
          completeWithPreparedSimpleCompletionModel:
            completeWithPreparedSimpleCompletionModel as never,
          runCliAgent: runCliAgent as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
        },
      }),
    ).rejects.toBe(budgetError);

    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });
});
