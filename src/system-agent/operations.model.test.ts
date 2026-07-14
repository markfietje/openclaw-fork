// Default-model mutation tests cover live verification and concurrent config edits.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import { executeSystemAgentOperation } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.test-helpers.js";

type TestConfig = Record<string, unknown>;

function parseLastJsonLine(raw: string): unknown {
  const lastLine = raw.trim().split("\n").at(-1);
  if (!lastLine) {
    throw new Error("Expected audit log to contain at least one JSON line");
  }
  return JSON.parse(lastLine) as unknown;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectAuditRecord(
  audit: unknown,
  fields: Record<string, unknown>,
  detailFields: Record<string, unknown>,
) {
  const auditRecord = requireRecord(audit, "audit record");
  expectRecordFields(auditRecord, fields);
  expectRecordFields(requireRecord(auditRecord.details, "audit details"), detailFields);
}

const mockConfig = vi.hoisted(() => {
  const state = {
    path: "/tmp/openclaw.json",
    exists: true,
    config: {} as TestConfig,
    hash: "mock-hash-0" as string | undefined,
  };
  const cloneConfig = () => structuredClone(state.config);
  const snapshot = () => {
    const config = cloneConfig();
    return {
      path: state.path,
      exists: state.exists,
      raw: state.exists ? `${JSON.stringify(config)}\n` : null,
      parsed: state.exists ? config : undefined,
      sourceConfig: config,
      resolved: config,
      valid: state.exists,
      runtimeConfig: config,
      config,
      hash: state.hash,
      issues: state.exists ? [] : [{ path: "", message: "missing config" }],
      warnings: [],
      legacyIssues: [],
    };
  };
  return {
    reset() {
      state.path = "/tmp/openclaw.json";
      state.exists = true;
      state.config = {};
      state.hash = "mock-hash-0";
    },
    currentConfig() {
      return cloneConfig();
    },
    setConfig(config: TestConfig) {
      state.config = structuredClone(config);
    },
    readConfigFileSnapshot: vi.fn(async () => snapshot()),
    mutateConfigFile: vi.fn(
      async (params: {
        writeOptions?: {
          preCommitRuntimePreflight?: (sourceConfig: TestConfig) => Promise<unknown>;
        };
        mutate: (
          draft: TestConfig,
          context: { snapshot: ReturnType<typeof snapshot> },
        ) => Promise<void> | void;
      }) => {
        const before = snapshot();
        const draft = cloneConfig();
        await params.mutate(draft, { snapshot: before });
        await params.writeOptions?.preCommitRuntimePreflight?.(structuredClone(draft));
        state.exists = true;
        state.config = draft;
        state.hash = "mock-hash-1";
        return {
          path: state.path,
          previousHash: before.hash ?? null,
          persistedHash: before.hash ?? null,
          snapshot: before,
          nextConfig: cloneConfig(),
          result: undefined,
        };
      },
    ),
  };
});

vi.mock("./probes.js", () => ({
  probeLocalCommand: vi.fn(async (command: string) => ({
    command,
    found: false,
    error: "not found",
  })),
  probeGatewayUrl: vi.fn(async (url: string) => ({ reachable: false, url, error: "offline" })),
}));

vi.mock("./overview.js", () => ({
  formatSystemAgentOverview: () => "Default model: openai/gpt-5.5",
  loadSystemAgentOverview: vi.fn(async () => ({
    defaultAgentId: "main",
    defaultModel: undefined,
    agents: [],
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
    tools: {
      codex: { command: "codex", found: false, error: "not found" },
      claude: { command: "claude", found: false, error: "not found" },
      gemini: { command: "gemini", found: false, error: "not found" },
      apiKeys: { openai: true, anthropic: false },
    },
    gateway: {
      url: "ws://127.0.0.1:18789",
      source: "local loopback",
      reachable: false,
      error: "offline",
    },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  })),
}));

vi.mock("../config/config.js", () => ({
  mutateConfigFile: mockConfig.mutateConfigFile,
  readConfigFileSnapshot: mockConfig.readConfigFileSnapshot,
}));

const opTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("executeSystemAgentOperation model changes", () => {
  let stateDirSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeEach(() => {
    mockConfig.reset();
    stateDirSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    stateDirSnapshot?.restore();
    vi.unstubAllEnvs();
  });

  it("live-verifies a staged default model before writing and preserves concurrent edits", async () => {
    const tempDir = opTempDirs.make("openclaw-verified-model-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    mockConfig.setConfig({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["openai/gpt-5.2"] },
        },
        list: [{ id: "main", default: true, workspace: "/tmp/main" }],
      },
      gateway: { port: 18789 },
      models: { providers: { openai: { baseUrl: "https://api.openai.com/v1" } } },
    });
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    let verificationCalls = 0;
    const verifyInferenceConfig = vi.fn(async ({ config }: { config: TestConfig }) => {
      verificationCalls += 1;
      const stagedDefaults = requireRecord(
        requireRecord(config.agents, "agents").defaults,
        "defaults",
      );
      expect(stagedDefaults.model).toEqual({
        primary: "openai/gpt-5.5",
        fallbacks: ["openai/gpt-5.2"],
      });
      expect(
        requireRecord(
          requireRecord(
            requireRecord(mockConfig.currentConfig().agents, "agents").defaults,
            "defaults",
          ).model,
          "persisted model",
        ).primary,
      ).toBe("anthropic/claude-sonnet-4-6");
      if (verificationCalls === 1) {
        const current = mockConfig.currentConfig();
        const currentModels = requireRecord(current.models, "models");
        const currentProviders = requireRecord(currentModels.providers, "providers");
        mockConfig.setConfig({
          ...current,
          auth: {
            profiles: { "google:other": { provider: "google", mode: "api_key" } },
          },
          models: {
            ...currentModels,
            providers: {
              ...currentProviders,
              google: {
                baseUrl: "https://example.invalid",
                models: [{ id: "unrelated", name: "Unrelated", contextWindow: 1, maxTokens: 1 }],
              },
            },
          },
          agents: {
            ...requireRecord(current.agents, "agents"),
            defaults: {
              ...requireRecord(requireRecord(current.agents, "agents").defaults, "defaults"),
              models: { "google/unrelated": { agentRuntime: { id: "openclaw" } } },
            },
            list: [
              { id: "main", default: true, workspace: "/tmp/main" },
              { id: "work", workspace: "/tmp/work" },
            ],
          },
          channels: { telegram: { enabled: true } },
        });
      }
      return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 17 };
    });

    const result = await executeSystemAgentOperation(
      { kind: "set-default-model", model: "openai/gpt-5.5" },
      runtime,
      { approved: true, deps: { verifyInferenceConfig } },
    );

    expect(result).toEqual({ applied: true });
    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(verifyInferenceConfig).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ requireExecutionOwner: true }),
    );
    expect(verifyInferenceConfig).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requireExecutionOwner: true }),
    );
    expect(mockConfig.mutateConfigFile).toHaveBeenCalledOnce();
    expect(mockConfig.mutateConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        writeOptions: { preCommitRuntimePreflight: expect.any(Function) },
      }),
    );
    const persisted = mockConfig.currentConfig();
    expect(
      requireRecord(requireRecord(persisted.agents, "agents").defaults, "defaults").model,
    ).toEqual({ primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.2"] });
    expect(requireRecord(persisted.agents, "agents").list).toEqual([
      { id: "main", default: true, workspace: "/tmp/main" },
      { id: "work", workspace: "/tmp/work" },
    ]);
    expect(requireRecord(persisted.auth, "auth").profiles).toEqual({
      "google:other": { provider: "google", mode: "api_key" },
    });
    expect(
      requireRecord(requireRecord(persisted.models, "models").providers, "providers"),
    ).toMatchObject({
      openai: { baseUrl: "https://api.openai.com/v1" },
      google: expect.any(Object),
    });
    expect(
      requireRecord(
        requireRecord(requireRecord(persisted.agents, "agents").defaults, "defaults").models,
        "default models",
      ),
    ).toHaveProperty("google/unrelated");
    expect(persisted.channels).toEqual({ telegram: { enabled: true } });
    expect(lines.join("\n")).toContain("Default model: openai/gpt-5.5");

    const audit = parseLastJsonLine(
      await fs.readFile(path.join(tempDir, "audit", "system-agent.jsonl"), "utf8"),
    );
    expectAuditRecord(
      audit,
      {
        operation: "config.setDefaultModel",
        summary: "Set default model to openai/gpt-5.5",
      },
      {
        requestedModel: "openai/gpt-5.5",
        effectiveModel: "openai/gpt-5.5",
        inferenceVerified: true,
        inferenceLatencyMs: 17,
      },
    );
  });

  it.each([
    {
      field: "default agent",
      initial: {
        agents: {
          defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
          list: [{ id: "main", default: true }, { id: "work" }],
        },
      },
      change: (config: TestConfig) => {
        const next = structuredClone(config);
        const list = requireRecord(next.agents, "agents").list as Array<{
          id: string;
          default?: boolean;
        }>;
        delete list[0]?.default;
        list[1]!.default = true;
        return next;
      },
    },
    {
      field: "default marker",
      initial: {
        agents: {
          defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
          list: [{ id: "main", default: true }, { id: "work" }],
        },
      },
      change: (config: TestConfig) => {
        const next = structuredClone(config);
        const list = requireRecord(next.agents, "agents").list as Array<{
          id: string;
          default?: boolean;
        }>;
        delete list[0]?.default;
        return next;
      },
    },
    {
      field: "auth profile order",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        auth: { order: { anthropic: ["anthropic:one"] } },
      },
      change: (config: TestConfig) => ({
        ...structuredClone(config),
        auth: { order: { anthropic: ["anthropic:two"] } },
      }),
    },
    {
      field: "runtime metadata",
      initial: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: {
              "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      },
      change: (config: TestConfig) => {
        const next = structuredClone(config);
        const defaults = requireRecord(requireRecord(next.agents, "agents").defaults, "defaults");
        defaults.models = {
          "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "openclaw" } },
        };
        return next;
      },
    },
    {
      field: "model",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
      },
      change: (config: TestConfig) => {
        const next = structuredClone(config);
        const defaults = requireRecord(requireRecord(next.agents, "agents").defaults, "defaults");
        defaults.model = { primary: "anthropic/claude-opus-4-6" };
        return next;
      },
    },
    {
      field: "config-backed environment",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        env: { vars: { ANTHROPIC_API_KEY: "first" } },
      },
      change: (config: TestConfig) => ({
        ...structuredClone(config),
        env: { vars: { ANTHROPIC_API_KEY: "second" } },
      }),
    },
    {
      field: "secret provider policy",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        secrets: { defaults: { env: "first" } },
      },
      change: (config: TestConfig) => ({
        ...structuredClone(config),
        secrets: { defaults: { env: "second" } },
      }),
    },
    {
      field: "plugin load policy",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        plugins: { enabled: true },
      },
      change: (config: TestConfig) => ({
        ...structuredClone(config),
        plugins: { enabled: false },
      }),
    },
  ])(
    "aborts when concurrent $field changes invalidate the verified route",
    async ({ initial, change }) => {
      const tempDir = opTempDirs.make("openclaw-route-conflict-");
      setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
      mockConfig.setConfig(initial);
      mockConfig.mutateConfigFile.mockClear();
      const { runtime, lines } = createSystemAgentTestRuntime();
      const verifyInferenceConfig = vi.fn(async () => {
        mockConfig.setConfig(change(mockConfig.currentConfig()));
        return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 7 };
      });

      await expect(
        executeSystemAgentOperation(
          { kind: "set-default-model", model: "openai/gpt-5.5" },
          runtime,
          {
            approved: true,
            deps: { verifyInferenceConfig },
          },
        ),
      ).rejects.toThrow("inference route changed during verification");

      expect(mockConfig.mutateConfigFile).toHaveBeenCalledOnce();
      expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
      await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
    },
  );

  it("keeps the working model and writes no audit when live inference fails", async () => {
    const tempDir = opTempDirs.make("openclaw-rejected-model-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
      gateway: { port: 18789 },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: false as const,
      status: "auth" as const,
      error: "Provider authentication failed.",
    }));

    await expect(
      executeSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
      }),
    ).rejects.toThrow(
      "The requested model failed a live inference test, so the current default model was not changed. Provider authentication failed. Fix provider authentication or model access, then retry.",
    );

    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(mockConfig.mutateConfigFile).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("writes nothing when the exact latest route fails its locked recheck", async () => {
    const tempDir = opTempDirs.make("openclaw-latest-route-rejected-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    const verifyInferenceConfig = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, modelRef: "openai/gpt-5.5", latencyMs: 5 })
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "credential changed" });

    await expect(
      executeSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
      }),
    ).rejects.toThrow("no longer passes live inference at the config commit boundary");

    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("rejects a live result from a different model before opening the write boundary", async () => {
    const tempDir = opTempDirs.make("openclaw-mismatched-model-result-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.4",
      latencyMs: 5,
    }));

    await expect(
      executeSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
      }),
    ).rejects.toThrow("did not verify the exact model route");

    expect(verifyInferenceConfig).toHaveBeenCalledOnce();
    expect(mockConfig.mutateConfigFile).not.toHaveBeenCalled();
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("rejects a different model result from the final commit-boundary probe", async () => {
    const tempDir = opTempDirs.make("openclaw-final-mismatched-model-result-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    const verifyInferenceConfig = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, modelRef: "openai/gpt-5.5", latencyMs: 5 })
      .mockResolvedValueOnce({ ok: true, modelRef: "openai/gpt-5.4", latencyMs: 5 });

    await expect(
      executeSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
      }),
    ).rejects.toThrow("did not verify the exact model route at the config commit boundary");

    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("rechecks the existing inference binding inside the locked model transform", async () => {
    const tempDir = opTempDirs.make("openclaw-model-binding-rotated-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    let bindingOwner = "verified";
    const verifyInferenceConfig = vi.fn(async () => {
      bindingOwner = "rotated";
      return {
        ok: true as const,
        modelRef: "openai/gpt-5.5",
        latencyMs: 5,
      };
    });
    const beforePersistentApply = vi.fn(async () => {
      if (bindingOwner !== "verified") {
        throw new SystemAgentInferenceUnavailableError("conversation");
      }
    });

    await expect(
      executeSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
        beforePersistentApply,
      }),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);

    expect(verifyInferenceConfig).toHaveBeenCalledOnce();
    expect(beforePersistentApply).toHaveBeenCalledOnce();
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("rechecks the existing inference binding after the candidate's final live probe", async () => {
    const tempDir = opTempDirs.make("openclaw-model-binding-final-probe-rotated-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    let bindingOwner = "verified";
    let verificationCalls = 0;
    const verifyInferenceConfig = vi.fn(async () => {
      verificationCalls += 1;
      if (verificationCalls === 2) {
        bindingOwner = "rotated";
      }
      return {
        ok: true as const,
        modelRef: "openai/gpt-5.5",
        latencyMs: 5,
      };
    });
    const beforePersistentApply = vi.fn(async () => {
      if (bindingOwner !== "verified") {
        throw new SystemAgentInferenceUnavailableError("conversation");
      }
    });

    await expect(
      executeSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
        beforePersistentApply,
      }),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);

    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(beforePersistentApply).toHaveBeenCalledTimes(2);
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("stages and persists model changes at the effective default-agent owner", async () => {
    const tempDir = opTempDirs.make("openclaw-default-agent-model-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    mockConfig.setConfig({
      agents: {
        defaults: { model: { primary: "anthropic/global-default" } },
        list: [
          {
            id: "work",
            default: true,
            model: { primary: "anthropic/work-default" },
          },
        ],
      },
    });
    const { runtime } = createSystemAgentTestRuntime();
    const verifyInferenceConfig = vi.fn(async ({ config }: { config: TestConfig }) => {
      const agents = requireRecord(config.agents, "agents");
      expect(requireRecord(agents.defaults, "defaults").model).toEqual({
        primary: "anthropic/global-default",
      });
      const list = agents.list as Array<{ id: string; model: unknown }>;
      expect(list.find((agent) => agent.id === "work")?.model).toEqual({
        primary: "openai/gpt-5.5",
      });
      return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 9 };
    });

    await executeSystemAgentOperation(
      { kind: "set-default-model", model: "openai/gpt-5.5" },
      runtime,
      { approved: true, deps: { verifyInferenceConfig } },
    );

    const agents = requireRecord(mockConfig.currentConfig().agents, "agents");
    expect(requireRecord(agents.defaults, "defaults").model).toEqual({
      primary: "anthropic/global-default",
    });
    const list = agents.list as Array<{ id: string; model: unknown }>;
    expect(list.find((agent) => agent.id === "work")?.model).toEqual({
      primary: "openai/gpt-5.5",
    });
  });
});
