// Simple completion runtime tests cover model resolution, provider auth, and
// one-shot completion wiring before requests reach the shared LLM stream path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";

// Hoisted mocks keep Vitest module replacement stable while the implementation
// under test imports auth, model resolution, and transport helpers at module load.
const hoisted = vi.hoisted(() => ({
  resolveModelMock: vi.fn(),
  resolveModelAsyncMock: vi.fn(),
  getApiKeyForModelMock: vi.fn(),
  applyLocalNoAuthHeaderOverrideMock: vi.fn(),
  setRuntimeApiKeyMock: vi.fn(),
  resolveCopilotApiTokenMock: vi.fn(),
  prepareProviderRuntimeAuthMock: vi.fn(),
  getRuntimeConfigMock: vi.fn(),
  prepareModelForSimpleCompletionMock: vi.fn((params: { model: unknown }) => params.model),
  streamSimpleMock: vi.fn(),
  completeMock: vi.fn(),
  acquireAgentUsageBudgetAdmissionMock: vi.fn(),
  recordAgentUsageBudgetAdmissionResultMock: vi.fn(),
  resolveUsageBudgetCostMultiplierUsageMock: vi.fn((params: { usage?: unknown }) => params.usage),
  resolveAgentUsageBudgetConfigMock: vi.fn(),
  hasAnyActiveAgentUsageBudgetConfigMock: vi.fn(),
  isAgentUsageBudgetErrorMock: vi.fn(),
  isModelProviderDispatchObservableStreamFnMock: vi.fn(),
  resolveProviderDispatchModelForStreamFnMock: vi.fn((params: { model: unknown }) => params.model),
  resolveProviderDispatchCostMultiplierForStreamFnMock: vi.fn(() => 1),
  resolveProviderDispatchReservationCostMultiplierForStreamFnMock: vi.fn(() => 1),
}));

vi.mock("../llm/stream.js", () => ({
  streamSimple: (...args: unknown[]) => hoisted.streamSimpleMock(...args),
}));

vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModel: hoisted.resolveModelMock,
  resolveModelAsync: hoisted.resolveModelAsyncMock,
}));

vi.mock("./simple-completion-transport.js", () => ({
  prepareModelForSimpleCompletion: hoisted.prepareModelForSimpleCompletionMock,
}));

vi.mock("./model-auth.js", () => ({
  formatMissingAuthError: vi.fn(
    (auth: { source: string; mode: string }, provider: string) =>
      `No API key resolved for provider "${provider}" (auth mode: ${auth.mode}, checked: ${auth.source}).`,
  ),
  getApiKeyForModel: hoisted.getApiKeyForModelMock,
  applyLocalNoAuthHeaderOverride: hoisted.applyLocalNoAuthHeaderOverrideMock,
}));

vi.mock("../plugin-sdk/provider-auth.js", () => ({
  resolveCopilotApiToken: hoisted.resolveCopilotApiTokenMock,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: hoisted.prepareProviderRuntimeAuthMock,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: hoisted.getRuntimeConfigMock,
}));

vi.mock("./usage-budget.js", () => {
  class AgentUsageBudgetError extends Error {
    readonly code = "agent_usage_budget_blocked";
    readonly details: unknown;

    constructor(message: string, details: unknown) {
      super(message);
      this.name = "AgentUsageBudgetError";
      this.details = details;
    }
  }

  return {
    acquireAgentUsageBudgetAdmission: hoisted.acquireAgentUsageBudgetAdmissionMock,
    AgentUsageBudgetError,
    buildUnsupportedAgentUsageBudgetStreamError: (params: {
      agentId?: string | null;
      provider: string;
      model: string;
    }) =>
      new AgentUsageBudgetError("unsupported stream", {
        agentId: params.agentId ?? "main",
        provider: params.provider,
        model: params.model,
        reason: "unsupported_stream",
      }),
    hasAnyActiveAgentUsageBudgetConfig: hoisted.hasAnyActiveAgentUsageBudgetConfigMock,
    recordAgentUsageBudgetAdmissionResult: hoisted.recordAgentUsageBudgetAdmissionResultMock,
    resolveUsageBudgetCostMultiplierUsage: hoisted.resolveUsageBudgetCostMultiplierUsageMock,
    resolveAgentUsageBudgetConfig: hoisted.resolveAgentUsageBudgetConfigMock,
    isAgentUsageBudgetError: hoisted.isAgentUsageBudgetErrorMock,
  };
});

vi.mock("./provider-dispatch-observable-stream.js", () => ({
  isModelProviderDispatchObservableStreamFn: hoisted.isModelProviderDispatchObservableStreamFnMock,
  resolveProviderDispatchModelForStreamFn: hoisted.resolveProviderDispatchModelForStreamFnMock,
  resolveProviderDispatchCostMultiplierForStreamFn:
    hoisted.resolveProviderDispatchCostMultiplierForStreamFnMock,
  resolveProviderDispatchReservationCostMultiplierForStreamFn:
    hoisted.resolveProviderDispatchReservationCostMultiplierForStreamFnMock,
}));

import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";

function createBudgetAdmissionRelease(timestampMs = 12345) {
  return Object.assign(vi.fn(), { timestampMs });
}

beforeEach(() => {
  hoisted.resolveModelMock.mockReset();
  hoisted.resolveModelAsyncMock.mockReset();
  hoisted.getApiKeyForModelMock.mockReset();
  hoisted.applyLocalNoAuthHeaderOverrideMock.mockReset();
  hoisted.setRuntimeApiKeyMock.mockReset();
  hoisted.resolveCopilotApiTokenMock.mockReset();
  hoisted.prepareProviderRuntimeAuthMock.mockReset();
  hoisted.getRuntimeConfigMock.mockReset();
  hoisted.prepareModelForSimpleCompletionMock.mockReset();
  hoisted.streamSimpleMock.mockReset();
  hoisted.completeMock.mockReset();
  hoisted.acquireAgentUsageBudgetAdmissionMock.mockReset();
  hoisted.recordAgentUsageBudgetAdmissionResultMock.mockReset();
  hoisted.resolveUsageBudgetCostMultiplierUsageMock.mockReset();
  hoisted.resolveAgentUsageBudgetConfigMock.mockReset();
  hoisted.hasAnyActiveAgentUsageBudgetConfigMock.mockReset();
  hoisted.isAgentUsageBudgetErrorMock.mockReset();
  hoisted.isModelProviderDispatchObservableStreamFnMock.mockReset();
  hoisted.resolveProviderDispatchModelForStreamFnMock.mockReset();
  hoisted.resolveProviderDispatchCostMultiplierForStreamFnMock.mockReset();
  hoisted.resolveProviderDispatchReservationCostMultiplierForStreamFnMock.mockReset();

  hoisted.applyLocalNoAuthHeaderOverrideMock.mockImplementation((model: unknown) => model);
  hoisted.prepareModelForSimpleCompletionMock.mockImplementation(
    (params: { model: unknown }) => params.model,
  );
  hoisted.completeMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  hoisted.streamSimpleMock.mockImplementation((...args: unknown[]) => ({
    result: () => hoisted.completeMock(...args),
  }));
  hoisted.acquireAgentUsageBudgetAdmissionMock.mockResolvedValue(undefined);
  hoisted.resolveAgentUsageBudgetConfigMock.mockReturnValue(undefined);
  hoisted.hasAnyActiveAgentUsageBudgetConfigMock.mockReturnValue(false);
  hoisted.isAgentUsageBudgetErrorMock.mockReturnValue(false);
  hoisted.isModelProviderDispatchObservableStreamFnMock.mockReturnValue(true);
  hoisted.resolveProviderDispatchModelForStreamFnMock.mockImplementation(
    (params: { model: unknown }) => params.model,
  );
  hoisted.resolveProviderDispatchCostMultiplierForStreamFnMock.mockReturnValue(1);
  hoisted.resolveProviderDispatchReservationCostMultiplierForStreamFnMock.mockImplementation(() =>
    hoisted.resolveProviderDispatchCostMultiplierForStreamFnMock(),
  );
  hoisted.resolveUsageBudgetCostMultiplierUsageMock.mockImplementation(
    (params: { usage?: unknown }) => params.usage,
  );

  hoisted.resolveModelMock.mockReturnValue({
    model: {
      provider: "anthropic",
      id: "claude-opus-4-6",
    },
    authStorage: {
      setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
    },
    modelRegistry: {},
  });
  hoisted.resolveModelAsyncMock.mockImplementation((...args: unknown[]) =>
    Promise.resolve(hoisted.resolveModelMock(...args)),
  );
  hoisted.getApiKeyForModelMock.mockResolvedValue({
    apiKey: "sk-test",
    source: "env:TEST_API_KEY",
    mode: "api-key",
  });
  hoisted.resolveCopilotApiTokenMock.mockResolvedValue({
    token: "copilot-runtime-token",
    expiresAt: Date.now() + 60_000,
    source: "cache:/tmp/copilot-token.json",
    baseUrl: "https://api.individual.githubcopilot.com",
  });
  hoisted.prepareProviderRuntimeAuthMock.mockResolvedValue(undefined);
  hoisted.getRuntimeConfigMock.mockReturnValue({});
});

function expectPreparedModelResult(
  result: Awaited<ReturnType<typeof prepareSimpleCompletionModel>>,
): asserts result is Exclude<typeof result, { error: string }> {
  expect(result).not.toHaveProperty("error");
  if ("error" in result) {
    throw new Error(result.error);
  }
}

function callArg(mock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call[0];
}

describe("prepareSimpleCompletionModel", () => {
  it("resolves model auth and sets runtime api key", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: " sk-test ",
      source: "env:TEST_API_KEY",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/openclaw-agent",
    });

    expectPreparedModelResult(result);
    expect(result.model.provider).toBe("anthropic");
    expect(result.model.id).toBe("claude-opus-4-6");
    expect(result.auth.mode).toBe("api-key");
    expect(result.auth.source).toBe("env:TEST_API_KEY");
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith("anthropic", "sk-test");
  });

  it("returns error when model resolution fails", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      error: "Unknown model: anthropic/missing-model",
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "missing-model",
    });

    expect(result).toEqual({
      error: "Unknown model: anthropic/missing-model",
    });
    expect(hoisted.getApiKeyForModelMock).not.toHaveBeenCalled();
  });

  it("returns error when api key is missing and mode is not allowlisted", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      source: "models.providers.anthropic",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(result).toEqual({
      error:
        'No API key resolved for provider "anthropic" (auth mode: api-key, checked: models.providers.anthropic).',
      auth: {
        source: "models.providers.anthropic",
        mode: "api-key",
      },
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("continues without api key when auth mode is allowlisted", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "amazon-bedrock",
        id: "anthropic.claude-sonnet-4-6",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      source: "aws-sdk default chain",
      mode: "aws-sdk",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-sonnet-4-6",
      allowMissingApiKeyModes: ["aws-sdk"],
    });

    expectPreparedModelResult(result);
    expect(result.model.provider).toBe("amazon-bedrock");
    expect(result.model.id).toBe("anthropic.claude-sonnet-4-6");
    expect(result.auth).toEqual({
      source: "aws-sdk default chain",
      mode: "aws-sdk",
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("exchanges github token when provider is github-copilot", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      source: "profile:github-copilot:default",
      mode: "token",
    });

    await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(hoisted.resolveCopilotApiTokenMock).toHaveBeenCalledWith({
      githubToken: "ghu_test",
    });
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith(
      "github-copilot",
      "copilot-runtime-token",
    );
  });

  it("returns exchanged copilot token in auth.apiKey for github-copilot provider", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_original_github_token",
      source: "profile:github-copilot:default",
      mode: "token",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }

    // Callers must only receive the short-lived Copilot runtime token. The
    // original GitHub token is broader auth material and must not leave prep.
    expect(result.auth.apiKey).toBe("copilot-runtime-token");
    expect(result.auth.apiKey).not.toBe("ghu_original_github_token");
  });

  it("applies exchanged copilot baseUrl to returned model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      source: "profile:github-copilot:default",
      mode: "token",
    });
    hoisted.resolveCopilotApiTokenMock.mockResolvedValueOnce({
      token: "copilot-runtime-token",
      expiresAt: Date.now() + 60_000,
      source: "cache:/tmp/copilot-token.json",
      baseUrl: "https://api.copilot.enterprise.example",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }
    expect(result.model.baseUrl).toBe("https://api.copilot.enterprise.example");
  });

  it("returns error when getApiKeyForModel throws", async () => {
    hoisted.getApiKeyForModelMock.mockRejectedValueOnce(new Error("Profile not found: copilot"));

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(result).toEqual({
      error: 'Auth lookup failed for provider "anthropic": Profile not found: copilot',
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("applies local no-auth header override before returning model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "local-openai",
        id: "chat-local",
        api: "openai-completions",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "custom-local",
      source: "models.providers.local-openai (synthetic local key)",
      mode: "api-key",
    });
    hoisted.applyLocalNoAuthHeaderOverrideMock.mockReturnValueOnce({
      provider: "local-openai",
      id: "chat-local",
      api: "openai-completions",
      headers: { Authorization: null },
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "local-openai",
      modelId: "chat-local",
    });

    const overrideCall = hoisted.applyLocalNoAuthHeaderOverrideMock.mock.calls.at(0);
    expect((overrideCall?.[0] as { provider?: string; id?: string } | undefined)?.provider).toBe(
      "local-openai",
    );
    expect((overrideCall?.[0] as { provider?: string; id?: string } | undefined)?.id).toBe(
      "chat-local",
    );
    expect((overrideCall?.[1] as { apiKey?: string; source?: string; mode?: string })?.apiKey).toBe(
      "custom-local",
    );
    expect((overrideCall?.[1] as { apiKey?: string; source?: string; mode?: string })?.source).toBe(
      "models.providers.local-openai (synthetic local key)",
    );
    expect((overrideCall?.[1] as { apiKey?: string; source?: string; mode?: string })?.mode).toBe(
      "api-key",
    );
    expectPreparedModelResult(result);
    expect(result.model.headers?.Authorization).toBeNull();
  });

  it("applies provider runtime auth before storing simple-completion credentials", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "amazon-bedrock-mantle",
        id: "anthropic.claude-opus-4-7",
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "__amazon_bedrock_mantle_iam__",
      source: "models.providers.amazon-bedrock-mantle.apiKey",
      mode: "api-key",
      profileId: "mantle",
    });
    hoisted.prepareProviderRuntimeAuthMock.mockResolvedValueOnce({
      apiKey: "bedrock-runtime-token",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "amazon-bedrock-mantle",
      modelId: "anthropic.claude-opus-4-7",
      agentDir: "/tmp/openclaw-agent",
    });

    const runtimeAuthInput = callArg(hoisted.prepareProviderRuntimeAuthMock) as {
      provider?: string;
      workspaceDir?: string;
      context?: {
        apiKey?: string;
        authMode?: string;
        modelId?: string;
        profileId?: string;
      };
    };
    expect(runtimeAuthInput.provider).toBe("amazon-bedrock-mantle");
    expect(runtimeAuthInput.workspaceDir).toBe("/tmp/openclaw-agent");
    expect(runtimeAuthInput.context?.apiKey).toBe("__amazon_bedrock_mantle_iam__");
    expect(runtimeAuthInput.context?.authMode).toBe("api-key");
    expect(runtimeAuthInput.context?.modelId).toBe("anthropic.claude-opus-4-7");
    expect(runtimeAuthInput.context?.profileId).toBe("mantle");
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith(
      "amazon-bedrock-mantle",
      "bedrock-runtime-token",
    );
    expectPreparedModelResult(result);
    expect(result.model.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic");
    expect(result.auth.apiKey).toBe("bedrock-runtime-token");
  });

  it("can skip agent model/auth discovery for config-scoped one-shot completions", async () => {
    hoisted.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: "ollama",
        id: "llama3.2:latest",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ollama-local",
      source: "models.json (local marker)",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "ollama",
      modelId: "llama3.2:latest",
      skipAgentDiscovery: true,
      modelResolver: hoisted.resolveModelAsyncMock,
    });

    expect(result).not.toHaveProperty("error");
    expect(hoisted.resolveModelMock).not.toHaveBeenCalled();
    expect(hoisted.resolveModelAsyncMock).toHaveBeenCalledWith(
      "ollama",
      "llama3.2:latest",
      undefined,
      undefined,
      {
        skipAgentDiscovery: true,
      },
    );
  });

  it("can preserve asynchronous provider model discovery", async () => {
    // Use a standalone mock so the default beforeEach delegation from
    // resolveModelAsyncMock → resolveModelMock does not pollute call
    // history. The point of the test is that when useAsyncModelResolution
    // is true, only the async resolver is invoked.
    const resolveModelAsync = vi.fn().mockResolvedValue({
      model: {
        provider: "anthropic",
        id: "claude-opus-4-6",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    // Reset the hoisted sync mock so any leftover calls from earlier tests
    // or beforeEach setup don't cause a false positive.
    hoisted.resolveModelMock.mockReset();

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      useAsyncModelResolution: true,
      modelResolver: resolveModelAsync,
    });

    expectPreparedModelResult(result);
    expect(hoisted.resolveModelMock).not.toHaveBeenCalled();
    expect(resolveModelAsync).toHaveBeenCalledWith(
      "anthropic",
      "claude-opus-4-6",
      undefined,
      undefined,
      {},
    );
  });

  it("passes static catalog fallback opt-in to skip-discovery model resolution", async () => {
    hoisted.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: "mistral",
        id: "mistral-medium-3-5",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      allowBundledStaticCatalogFallback: true,
      skipAgentDiscovery: true,
      modelResolver: hoisted.resolveModelAsyncMock,
    });

    expect(result).not.toHaveProperty("error");
    expect(hoisted.resolveModelAsyncMock).toHaveBeenCalledWith(
      "mistral",
      "mistral-medium-3-5",
      undefined,
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        skipAgentDiscovery: true,
      },
    );
  });
});

describe("prepareSimpleCompletionModelForAgent", () => {
  it("uses Codex auth provider for OpenAI model refs with Codex runtime policy", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
          models: {
            "openai/gpt-5.4-mini": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } as OpenClawConfig;
    hoisted.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: "openai",
        id: "gpt-5.4-mini",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModelForAgent({
      cfg,
      agentId: "main",
      skipAgentDiscovery: true,
      modelResolver: hoisted.resolveModelAsyncMock,
    });

    expectPreparedModelResult(result);
    expect(result.selection.provider).toBe("openai");
    expect(result.selection.modelId).toBe("gpt-5.4-mini");
    expect(result.selection.runtimeProvider).toBe("openai");
    expect(hoisted.resolveModelAsyncMock).toHaveBeenCalledWith(
      "openai",
      "gpt-5.4-mini",
      expect.any(String),
      cfg,
      {
        skipAgentDiscovery: true,
      },
    );
    expect(
      (callArg(hoisted.getApiKeyForModelMock) as { model?: { provider?: string } }).model?.provider,
    ).toBe("openai");
  });
});

describe("completeWithPreparedSimpleCompletionModel", () => {
  it("prepares provider-owned stream APIs before running a completion", async () => {
    const model = {
      provider: "ollama",
      id: "llama3.2:latest",
      name: "llama3.2:latest",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    } satisfies Model<"ollama">;
    const preparedModel = {
      ...model,
      api: "openclaw-ollama-simple-test",
    };
    const cfg = {
      models: { providers: { ollama: { baseUrl: "http://remote-ollama:11434", models: [] } } },
    };
    hoisted.prepareModelForSimpleCompletionMock.mockReturnValueOnce(preparedModel);

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: {
        apiKey: "ollama-local",
        source: "models.json (local marker)",
        mode: "api-key",
      },
      cfg,
      context: {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
    });

    expect(hoisted.prepareModelForSimpleCompletionMock).toHaveBeenCalledWith({ model, cfg });
    expect(hoisted.completeMock).toHaveBeenCalledWith(
      preparedModel,
      {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      {
        apiKey: "ollama-local",
      },
    );
  });

  it("enforces and records agent usage budgets at the shared simple-completion boundary", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;
    const cfg = {
      agents: {
        defaults: {
          usageBudget: { daily: { tokens: 100 } },
        },
      },
    } as OpenClawConfig;
    const release = createBudgetAdmissionRelease(12345);
    const usage = {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: {
        input: 0.000003,
        output: 0.00001,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.000013,
      },
    };
    hoisted.acquireAgentUsageBudgetAdmissionMock.mockResolvedValueOnce(release);
    hoisted.resolveAgentUsageBudgetConfigMock.mockReturnValueOnce({ daily: { tokens: 100 } });
    hoisted.completeMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage,
    });

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
        mode: "api-key",
      },
      cfg,
      context: {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      usageBudget: {
        config: cfg,
        agentId: "ops",
        provider: "openai",
        model: "gpt-5.5",
        recordIdPrefix: "test-simple",
      },
    });

    expect(hoisted.acquireAgentUsageBudgetAdmissionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        agentId: "ops",
        provider: "openai",
        model: "gpt-5.5",
        reservation: expect.objectContaining({ outputTokens: 4096 }),
        signal: undefined,
      }),
    );
    const admissionArgs = hoisted.acquireAgentUsageBudgetAdmissionMock.mock.calls[0]?.[0] as {
      usageBudgetOperationId?: string;
    };
    const recordArgs = hoisted.recordAgentUsageBudgetAdmissionResultMock.mock.calls[0]?.[0] as {
      usageBudgetOperationId?: string;
    };
    expect(recordArgs.usageBudgetOperationId).toBe(admissionArgs.usageBudgetOperationId);
    expect(hoisted.recordAgentUsageBudgetAdmissionResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        agentId: "ops",
        provider: "openai",
        model: "gpt-5.5",
        usage,
        timestampMs: 12345,
        recordId: expect.stringMatching(/^test-simple:12345:/),
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses dispatch-resolved simple-completion model identity and cost multiplier for budgets", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;
    const dispatchModel = {
      ...model,
      id: "gpt-5.5-priority-dispatch",
    } satisfies Model<"openai-responses">;
    const cfg = {
      agents: {
        defaults: {
          usageBudget: { daily: { usd: 0.01 } },
        },
      },
    } as OpenClawConfig;
    const usage = {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: {
        input: 0.000003,
        output: 0.00001,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.000013,
      },
    };
    const adjustedUsage = {
      ...usage,
      cost: { ...usage.cost, total: 0.000026 },
    };
    const release = createBudgetAdmissionRelease();
    hoisted.resolveProviderDispatchModelForStreamFnMock.mockReturnValueOnce(dispatchModel);
    hoisted.resolveProviderDispatchCostMultiplierForStreamFnMock.mockReturnValueOnce(2);
    hoisted.resolveProviderDispatchReservationCostMultiplierForStreamFnMock.mockReturnValueOnce(
      2.5,
    );
    hoisted.resolveUsageBudgetCostMultiplierUsageMock.mockReturnValueOnce(adjustedUsage);
    hoisted.acquireAgentUsageBudgetAdmissionMock.mockResolvedValueOnce(release);
    hoisted.resolveAgentUsageBudgetConfigMock.mockReturnValueOnce({ daily: { usd: 0.01 } });
    hoisted.completeMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage,
    });

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
        mode: "api-key",
      },
      cfg,
      context: {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      usageBudget: {
        config: cfg,
        agentId: "ops",
        provider: "openai",
        model: "gpt-5.5",
        recordIdPrefix: "test-simple",
      },
    });

    expect(hoisted.acquireAgentUsageBudgetAdmissionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        agentId: "ops",
        provider: "openai",
        model: "gpt-5.5-priority-dispatch",
        costMultiplier: 2.5,
        reservation: expect.objectContaining({ outputTokens: 4096 }),
      }),
    );
    expect(hoisted.resolveUsageBudgetCostMultiplierUsageMock).toHaveBeenCalledWith({
      config: cfg,
      provider: "openai",
      model: "gpt-5.5-priority-dispatch",
      usage,
      costMultiplier: 2,
    });
    expect(hoisted.recordAgentUsageBudgetAdmissionResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        agentId: "ops",
        provider: "openai",
        model: "gpt-5.5-priority-dispatch",
        usage: adjustedUsage,
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("allows attributed simple completions without dispatch observability when no budget is active", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;
    const cfg = {
      agents: {
        defaults: {},
      },
    } as OpenClawConfig;
    hoisted.isModelProviderDispatchObservableStreamFnMock.mockReturnValueOnce(false);

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
        mode: "api-key",
      },
      cfg,
      context: {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      usageBudget: {
        config: cfg,
        agentId: "ops",
        provider: "openai",
        model: "gpt-5.5",
      },
    });

    expect(hoisted.resolveAgentUsageBudgetConfigMock).toHaveBeenCalledWith({
      config: cfg,
      agentId: "ops",
    });
    expect(hoisted.isModelProviderDispatchObservableStreamFnMock).not.toHaveBeenCalled();
    expect(hoisted.streamSimpleMock).toHaveBeenCalledOnce();
    expect(hoisted.acquireAgentUsageBudgetAdmissionMock).not.toHaveBeenCalled();
    expect(hoisted.recordAgentUsageBudgetAdmissionResultMock).not.toHaveBeenCalled();
  });

  it("rejects unattributed simple completions before dispatch when any agent budget is configured", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;
    const cfg = {
      agents: {
        list: [
          {
            id: "ops",
            usageBudget: { daily: { tokens: 100 } },
          },
        ],
      },
    } as OpenClawConfig;
    hoisted.hasAnyActiveAgentUsageBudgetConfigMock.mockReturnValueOnce(true);

    await expect(
      completeWithPreparedSimpleCompletionModel({
        model,
        auth: {
          apiKey: "sk-test",
          source: "env:OPENAI_API_KEY",
          mode: "api-key",
        },
        cfg,
        context: {
          messages: [{ role: "user", content: "pong", timestamp: 1 }],
        },
      }),
    ).rejects.toMatchObject({
      code: "agent_usage_budget_blocked",
      details: {
        agentId: "unknown",
        provider: "openai",
        model: "gpt-5.5",
        reason: "unsupported_harness",
      },
    });

    expect(hoisted.hasAnyActiveAgentUsageBudgetConfigMock).toHaveBeenCalledWith(cfg);
    expect(hoisted.streamSimpleMock).not.toHaveBeenCalled();
    expect(hoisted.acquireAgentUsageBudgetAdmissionMock).not.toHaveBeenCalled();
    expect(hoisted.recordAgentUsageBudgetAdmissionResultMock).not.toHaveBeenCalled();
  });

  it("rejects unattributed prepared completions with active runtime-config budgets", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;
    const cfg = {
      agents: {
        defaults: {
          usageBudget: { daily: { tokens: 100 } },
        },
      },
    } as OpenClawConfig;
    hoisted.getRuntimeConfigMock.mockReturnValueOnce(cfg);
    hoisted.hasAnyActiveAgentUsageBudgetConfigMock.mockReturnValueOnce(true);

    await expect(
      completeWithPreparedSimpleCompletionModel({
        model,
        auth: {
          apiKey: "sk-test",
          source: "env:OPENAI_API_KEY",
          mode: "api-key",
        },
        context: {
          messages: [{ role: "user", content: "pong", timestamp: 1 }],
        },
      }),
    ).rejects.toMatchObject({
      code: "agent_usage_budget_blocked",
      details: {
        agentId: "unknown",
        provider: "openai",
        model: "gpt-5.5",
        reason: "unsupported_harness",
      },
    });

    expect(hoisted.getRuntimeConfigMock).toHaveBeenCalledOnce();
    expect(hoisted.prepareModelForSimpleCompletionMock).toHaveBeenCalledWith({ model, cfg });
    expect(hoisted.hasAnyActiveAgentUsageBudgetConfigMock).toHaveBeenCalledWith(cfg);
    expect(hoisted.streamSimpleMock).not.toHaveBeenCalled();
    expect(hoisted.acquireAgentUsageBudgetAdmissionMock).not.toHaveBeenCalled();
    expect(hoisted.recordAgentUsageBudgetAdmissionResultMock).not.toHaveBeenCalled();
  });

  it("does not persist unknown budget usage for pre-dispatch simple-completion failures", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.05 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;
    const cfg = {
      agents: {
        defaults: {
          usageBudget: { daily: { tokens: 100 } },
        },
      },
    } as OpenClawConfig;
    const release = createBudgetAdmissionRelease();
    const preDispatchError = Object.assign(
      new Error("No API provider registered for api: openai-responses"),
      {
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    );
    hoisted.acquireAgentUsageBudgetAdmissionMock.mockResolvedValueOnce(release);
    hoisted.resolveAgentUsageBudgetConfigMock.mockReturnValueOnce({ daily: { tokens: 100 } });
    hoisted.streamSimpleMock.mockImplementationOnce(() => {
      throw preDispatchError;
    });

    await expect(
      completeWithPreparedSimpleCompletionModel({
        model,
        auth: {
          apiKey: "sk-test",
          source: "env:OPENAI_API_KEY",
          mode: "api-key",
        },
        cfg,
        context: {
          messages: [{ role: "user", content: "pong", timestamp: 1 }],
        },
        usageBudget: {
          config: cfg,
          agentId: "ops",
          provider: "openai",
          model: "gpt-5.5",
        },
      }),
    ).rejects.toBe(preDispatchError);

    expect(hoisted.recordAgentUsageBudgetAdmissionResultMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not persist unknown budget usage for resolved pre-dispatch terminal errors", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.05 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;
    const cfg = {
      agents: {
        defaults: {
          usageBudget: { daily: { tokens: 100 } },
        },
      },
    } as OpenClawConfig;
    const release = createBudgetAdmissionRelease();
    const terminalError = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "No API provider registered for api: openai-responses",
      timestamp: Date.UTC(2026, 6, 15, 12),
    } as const;
    hoisted.acquireAgentUsageBudgetAdmissionMock.mockResolvedValueOnce(release);
    hoisted.resolveAgentUsageBudgetConfigMock.mockReturnValueOnce({ daily: { tokens: 100 } });
    hoisted.completeMock.mockResolvedValueOnce(terminalError);

    await expect(
      completeWithPreparedSimpleCompletionModel({
        model,
        auth: {
          apiKey: "sk-test",
          source: "env:OPENAI_API_KEY",
          mode: "api-key",
        },
        cfg,
        context: {
          messages: [{ role: "user", content: "pong", timestamp: 1 }],
        },
        usageBudget: {
          config: cfg,
          agentId: "ops",
          provider: "openai",
          model: "gpt-5.5",
        },
      }),
    ).resolves.toBe(terminalError);

    expect(hoisted.recordAgentUsageBudgetAdmissionResultMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("disables provider retries and records unknown usage when budgeted simple completions dispatch twice", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.05 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;
    const cfg = {
      agents: {
        defaults: {
          usageBudget: { daily: { tokens: 100 } },
        },
      },
    } as OpenClawConfig;
    const release = createBudgetAdmissionRelease();
    hoisted.acquireAgentUsageBudgetAdmissionMock.mockResolvedValueOnce(release);
    hoisted.resolveAgentUsageBudgetConfigMock.mockReturnValueOnce({ daily: { tokens: 100 } });
    hoisted.streamSimpleMock.mockImplementationOnce((_model, _context, options) => {
      const streamOptions = options as { maxRetries?: number; onProviderDispatch?: () => void };
      expect(streamOptions.maxRetries).toBe(0);
      streamOptions.onProviderDispatch?.();
      streamOptions.onProviderDispatch?.();
      return { result: async () => ({ content: [] }) };
    });

    await expect(
      completeWithPreparedSimpleCompletionModel({
        model,
        auth: {
          apiKey: "sk-test",
          source: "env:OPENAI_API_KEY",
          mode: "api-key",
        },
        cfg,
        context: {
          messages: [{ role: "user", content: "pong", timestamp: 1 }],
        },
        usageBudget: {
          config: cfg,
          agentId: "ops",
          provider: "openai",
          model: "gpt-5.5",
        },
      }),
    ).rejects.toMatchObject({
      code: "agent_usage_budget_blocked",
      details: {
        harnessId: "provider-retry",
        reason: "unsupported_harness",
      },
    });

    expect(hoisted.recordAgentUsageBudgetAdmissionResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        provider: "openai",
        model: "gpt-5.5",
        usage: undefined,
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects budgeted simple completions before unobservable stream dispatch", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.05 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;
    const cfg = {
      agents: {
        defaults: {
          usageBudget: { daily: { tokens: 100 } },
        },
      },
    } as OpenClawConfig;
    hoisted.isModelProviderDispatchObservableStreamFnMock.mockReturnValueOnce(false);
    hoisted.resolveAgentUsageBudgetConfigMock.mockReturnValueOnce({ daily: { tokens: 100 } });

    await expect(
      completeWithPreparedSimpleCompletionModel({
        model,
        auth: {
          apiKey: "sk-test",
          source: "env:OPENAI_API_KEY",
          mode: "api-key",
        },
        cfg,
        context: {
          messages: [{ role: "user", content: "pong", timestamp: 1 }],
        },
        usageBudget: {
          config: cfg,
          agentId: "ops",
          provider: "openai",
          model: "gpt-5.5",
        },
      }),
    ).rejects.toMatchObject({
      code: "agent_usage_budget_blocked",
      details: {
        agentId: "ops",
        provider: "openai",
        model: "gpt-5.5",
        reason: "unsupported_stream",
      },
    });

    expect(hoisted.streamSimpleMock).not.toHaveBeenCalled();
    expect(hoisted.acquireAgentUsageBudgetAdmissionMock).not.toHaveBeenCalled();
    expect(hoisted.recordAgentUsageBudgetAdmissionResultMock).not.toHaveBeenCalled();
  });

  it("normalizes OpenClaw-only thinking levels before using shared model runtime simple completion", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.4",
      name: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
        mode: "api-key",
      },
      context: {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      options: {
        reasoning: "max",
      },
    });

    expect(hoisted.completeMock).toHaveBeenCalledWith(
      model,
      {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      {
        reasoning: "xhigh",
        apiKey: "sk-test",
      },
    );
  });

  it("preserves max for GPT-5.6 simple completions", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.6-terra",
      name: "gpt-5.6-terra",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 372_000,
      maxTokens: 128_000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    } satisfies Model<"openai-responses">;

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
        mode: "api-key",
      },
      context: {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      options: {
        reasoning: "max",
      },
    });

    expect(hoisted.completeMock).toHaveBeenCalledWith(
      model,
      {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      {
        reasoning: "max",
        apiKey: "sk-test",
      },
    );
  });

  it("omits reasoning for local simple completion when thinking is off", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.4",
      name: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
        mode: "api-key",
      },
      context: {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      options: {
        reasoning: "off",
      },
    });

    expect(hoisted.completeMock).toHaveBeenCalledWith(
      model,
      {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      {
        apiKey: "sk-test",
      },
    );
  });
});
