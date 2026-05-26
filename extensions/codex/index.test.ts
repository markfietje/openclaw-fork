import fs from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import plugin from "./index.js";

const runCodexAppServerAttemptMock = vi.hoisted(() => vi.fn());
const runCodexAppServerSideQuestionMock = vi.hoisted(() => vi.fn());
const getSharedCodexAppServerClientMock = vi.hoisted(() => vi.fn());
const readCodexAppServerBindingMock = vi.hoisted(() => vi.fn());
const resolveCodexAppServerAuthProfileIdForAgentMock = vi.hoisted(() =>
  vi.fn((params: { authProfileId?: string }) => params.authProfileId),
);
const resolveCodexAppServerRuntimeOptionsMock = vi.hoisted(() =>
  vi.fn(() => ({ start: { command: "codex", args: ["app-server"] } })),
);

vi.mock("./src/app-server/run-attempt.js", () => ({
  runCodexAppServerAttempt: runCodexAppServerAttemptMock,
}));
vi.mock("./src/app-server/side-question.js", () => ({
  runCodexAppServerSideQuestion: runCodexAppServerSideQuestionMock,
}));
vi.mock("./src/app-server/shared-client.js", () => ({
  getSharedCodexAppServerClient: getSharedCodexAppServerClientMock,
}));
vi.mock("./src/app-server/config.js", () => ({
  resolveCodexAppServerRuntimeOptions: resolveCodexAppServerRuntimeOptionsMock,
}));
vi.mock("./src/app-server/auth-bridge.js", () => ({
  resolveCodexAppServerAuthProfileIdForAgent: resolveCodexAppServerAuthProfileIdForAgentMock,
}));
vi.mock("./src/app-server/session-binding.js", () => ({
  readCodexAppServerBinding: readCodexAppServerBindingMock,
}));

function mockCall(mock: { mock: { calls: unknown[][] } }, index = 0) {
  return mock.mock.calls.at(index);
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0) {
  return mockCall(mock, index)?.at(argIndex);
}

describe("codex plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is opt-in by default", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { enabledByDefault?: unknown };

    expect(manifest.enabledByDefault).toBeUndefined();
  });

  it("registers the codex provider and agent harness", () => {
    const registerAgentHarness = vi.fn();
    const registerCommand = vi.fn();
    const registerMediaUnderstandingProvider = vi.fn();
    const registerMigrationProvider = vi.fn();
    const registerProvider = vi.fn();
    const on = vi.fn();
    const onConversationBindingResolved = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentHarness,
        registerCommand,
        registerMediaUnderstandingProvider,
        registerMigrationProvider,
        registerProvider,
        on,
        onConversationBindingResolved,
      }),
    );

    const providerRegistration = mockCallArg(registerProvider) as Record<string, unknown>;
    const agentHarnessRegistration = mockCallArg(registerAgentHarness) as Record<string, unknown>;
    const mediaProviderRegistration = mockCallArg(registerMediaUnderstandingProvider) as
      | Record<string, unknown>
      | undefined;
    const inboundClaimRegistration = mockCall(on) as [unknown, unknown] | undefined;
    const bindingResolvedRegistration = mockCall(onConversationBindingResolved) as
      | [unknown]
      | undefined;

    expect(providerRegistration.id).toBe("codex");
    expect(providerRegistration.label).toBe("Codex");
    expect(agentHarnessRegistration.id).toBe("codex");
    expect(agentHarnessRegistration.label).toBe("Codex agent harness");
    expect(agentHarnessRegistration.deliveryDefaults).toEqual({
      sourceVisibleReplies: "message_tool",
    });
    expect(typeof agentHarnessRegistration.prewarm).toBe("function");
    expect(typeof agentHarnessRegistration.dispose).toBe("function");
    expect(mediaProviderRegistration?.id).toBe("codex");
    expect(mediaProviderRegistration?.capabilities).toEqual(["image"]);
    expect(mediaProviderRegistration?.defaultModels).toEqual({ image: "gpt-5.5" });
    expect(typeof mediaProviderRegistration?.describeImage).toBe("function");
    expect(typeof mediaProviderRegistration?.describeImages).toBe("function");
    const commandRegistration = mockCallArg(registerCommand) as Record<string, unknown> | undefined;
    expect(commandRegistration?.name).toBe("codex");
    expect(commandRegistration?.description).toBe(
      "Inspect and control the Codex app-server harness",
    );
    const migrationRegistration = mockCallArg(registerMigrationProvider) as
      | Record<string, unknown>
      | undefined;
    expect(migrationRegistration?.id).toBe("codex");
    expect(migrationRegistration?.label).toBe("Codex");
    expect(inboundClaimRegistration?.[0]).toBe("inbound_claim");
    expect(typeof inboundClaimRegistration?.[1]).toBe("function");
    expect(typeof bindingResolvedRegistration?.[0]).toBe("function");
  });

  it("prewarms existing sessions with the bound app-server auth profile", async () => {
    readCodexAppServerBindingMock.mockResolvedValueOnce({ authProfileId: "openai-codex:work" });
    getSharedCodexAppServerClientMock.mockResolvedValueOnce({});
    const harness = createCodexAppServerAgentHarness({ pluginConfig: { appServer: {} } });

    await expect(
      harness.prewarm?.({
        cfg: { agents: { list: [] } } as never,
        agentDir: "/tmp/openclaw-agent",
        provider: "codex",
        modelId: "gpt-5.5",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/openclaw-session.jsonl",
        reason: "tui-startup",
      }),
    ).resolves.toEqual({ warmed: true });

    expect(resolveCodexAppServerRuntimeOptionsMock).toHaveBeenCalledWith({
      pluginConfig: { appServer: {} },
    });
    expect(readCodexAppServerBindingMock).toHaveBeenCalledWith("/tmp/openclaw-session.jsonl", {
      agentDir: "/tmp/openclaw-agent",
      config: { agents: { list: [] } },
    });
    expect(resolveCodexAppServerAuthProfileIdForAgentMock).toHaveBeenCalledWith({
      authProfileId: "openai-codex:work",
      agentDir: "/tmp/openclaw-agent",
      config: { agents: { list: [] } },
    });
    expect(getSharedCodexAppServerClientMock).toHaveBeenCalledWith({
      startOptions: { command: "codex", args: ["app-server"] },
      timeoutMs: 60_000,
      agentDir: "/tmp/openclaw-agent",
      authProfileId: "openai-codex:work",
      config: { agents: { list: [] } },
    });
    expect(runCodexAppServerAttemptMock).not.toHaveBeenCalled();
  });

  it("registers with capture APIs that do not expose conversation binding hooks yet", () => {
    const registerProvider = vi.fn();
    const api = createTestPluginApi({
      id: "codex",
      name: "Codex",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      registerAgentHarness: vi.fn(),
      registerCommand: vi.fn(),
      registerMediaUnderstandingProvider: vi.fn(),
      registerProvider,
      on: vi.fn(),
    });
    delete (api as { onConversationBindingResolved?: unknown }).onConversationBindingResolved;

    plugin.register(api);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect((mockCallArg(registerProvider) as { id?: string } | undefined)?.id).toBe("codex");
  });

  it("only claims the codex provider by default", () => {
    const harness = createCodexAppServerAgentHarness();

    expect(harness.deliveryDefaults?.sourceVisibleReplies).toBe("message_tool");
    expect(
      harness.supports({ provider: "codex", modelId: "gpt-5.4", requestedRuntime: "auto" })
        .supported,
    ).toBe(true);
    const unsupported = harness.supports({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      requestedRuntime: "auto",
    });
    expect(unsupported.supported).toBe(false);
  });

  it("enables the native hook relay for public Codex app-server attempts", async () => {
    const harness = createCodexAppServerAgentHarness({ pluginConfig: { appServer: {} } });
    const result = { success: true };
    runCodexAppServerAttemptMock.mockResolvedValueOnce(result);

    await expect(harness.runAttempt({ prompt: "hello" } as never)).resolves.toBe(result);

    expect(runCodexAppServerAttemptMock).toHaveBeenCalledWith(
      { prompt: "hello" },
      {
        pluginConfig: { appServer: {} },
        nativeHookRelay: { enabled: true },
      },
    );
  });

  it("passes live Codex plugin config into public Codex app-server attempts", async () => {
    const registerAgentHarness = vi.fn();
    const liveConfig = {
      plugins: {
        entries: {
          codex: {
            config: {
              codexPlugins: {
                enabled: true,
                plugins: {
                  "google-calendar": {
                    marketplaceName: "openai-curated",
                    pluginName: "google-calendar",
                  },
                },
              },
            },
          },
        },
      },
    };
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { codexPlugins: { enabled: false } },
        runtime: {
          config: {
            current: () => liveConfig,
          },
        } as never,
        registerAgentHarness,
        registerCommand: vi.fn(),
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        on: vi.fn(),
      }),
    );
    const harness = mockCallArg(registerAgentHarness) as ReturnType<
      typeof createCodexAppServerAgentHarness
    >;
    const result = { success: true };
    runCodexAppServerAttemptMock.mockResolvedValueOnce(result);

    await expect(harness.runAttempt({ prompt: "calendar" } as never)).resolves.toBe(result);

    expect(runCodexAppServerAttemptMock).toHaveBeenCalledWith(
      { prompt: "calendar" },
      {
        pluginConfig: liveConfig.plugins.entries.codex.config,
        nativeHookRelay: { enabled: true },
      },
    );
  });

  it("enables the native hook relay for public Codex side questions", async () => {
    const harness = createCodexAppServerAgentHarness({ pluginConfig: { appServer: {} } });
    const runSideQuestion = harness.runSideQuestion;
    const result = { text: "ok" };
    runCodexAppServerSideQuestionMock.mockResolvedValueOnce(result);

    if (!runSideQuestion) {
      throw new Error("Expected Codex harness to expose side questions");
    }
    await expect(runSideQuestion({ question: "btw" } as never)).resolves.toBe(result);

    expect(runCodexAppServerSideQuestionMock).toHaveBeenCalledWith(
      { question: "btw" },
      {
        pluginConfig: { appServer: {} },
        nativeHookRelay: { enabled: true },
      },
    );
  });
});
