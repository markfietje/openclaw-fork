import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  applyModelOverrideToSessionEntry,
  clearStaleAutoRuntimeAuthProfileSelection,
  hasStaleAutoRuntimeAuthProfileSelection,
  repairProviderWrappedModelOverride,
} from "./model-overrides.js";

function applyOpenAiSelection(entry: SessionEntry) {
  return applyModelOverrideToSessionEntry({
    entry,
    selection: {
      provider: "openai",
      model: "gpt-5.4",
    },
  });
}

function expectRuntimeModelFieldsCleared(entry: SessionEntry, before: number) {
  expect(entry.providerOverride).toBe("openai");
  expect(entry.modelOverride).toBe("gpt-5.4");
  expect(entry.modelProvider).toBeUndefined();
  expect(entry.model).toBeUndefined();
  expect((entry.updatedAt ?? 0) > before).toBe(true);
}

function contextBudgetStatus(params: {
  updatedAt: number;
  provider: string;
  model: string;
  contextTokenBudget: number;
}): NonNullable<SessionEntry["contextBudgetStatus"]> {
  return {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: params.updatedAt,
    provider: params.provider,
    model: params.model,
    route: "fits",
    shouldCompact: false,
    estimatedPromptTokens: Math.floor(params.contextTokenBudget * 0.6),
    contextTokenBudget: params.contextTokenBudget,
    promptBudgetBeforeReserve: params.contextTokenBudget - 10_000,
    reserveTokens: 10_000,
    effectiveReserveTokens: 10_000,
    remainingPromptBudgetTokens: Math.floor(params.contextTokenBudget * 0.4),
    overflowTokens: 0,
    toolResultReducibleChars: 0,
    messageCount: 2,
    unwindowedMessageCount: 2,
  };
}

describe("stale auto runtime auth profile selection", () => {
  it("treats legacy compaction-count auth provenance as auto-owned", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-legacy-auto-auth",
      updatedAt: before,
      modelProvider: "deepseek",
      model: "deepseek-v4-flash",
      contextTokens: 64_000,
      authProfileOverride: "deepseek:default",
      authProfileOverrideCompactionCount: 2,
    };

    const isStale = hasStaleAutoRuntimeAuthProfileSelection(entry, {
      provider: "minimax",
      model: "MiniMax-M2.7",
    });
    const result = clearStaleAutoRuntimeAuthProfileSelection(entry, {
      provider: "minimax",
      model: "MiniMax-M2.7",
    });

    expect(isStale).toBe(true);
    expect(result.updated).toBe(true);
    expect(entry.modelProvider).toBeUndefined();
    expect(entry.model).toBeUndefined();
    expect(entry.contextTokens).toBeUndefined();
    expect(entry.authProfileOverride).toBeUndefined();
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
    expect((entry.updatedAt ?? 0) > before).toBe(true);
  });

  it("does not treat configured runtime-equivalent CLI aliases as stale", () => {
    const entry: SessionEntry = {
      sessionId: "sess-cli-runtime-alias",
      updatedAt: Date.now(),
      modelProvider: "claude-cli",
      model: "claude-opus-4-7",
      contextTokens: 200_000,
      authProfileOverride: "claude-cli:default",
      authProfileOverrideSource: "auto",
    };
    const config = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": { command: "claude" },
          },
        },
      },
    };

    const isStale = hasStaleAutoRuntimeAuthProfileSelection(entry, {
      provider: "anthropic",
      model: "claude-opus-4-7",
      config,
    });
    const result = clearStaleAutoRuntimeAuthProfileSelection(entry, {
      provider: "anthropic",
      model: "claude-opus-4-7",
      config,
    });

    expect(isStale).toBe(false);
    expect(result.updated).toBe(false);
    expect(entry.modelProvider).toBe("claude-cli");
    expect(entry.model).toBe("claude-opus-4-7");
    expect(entry.authProfileOverride).toBe("claude-cli:default");
  });
});

describe("applyModelOverrideToSessionEntry", () => {
  it("clears stale runtime model fields when switching overrides", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-1",
      updatedAt: before,
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      contextTokens: 160_000,
      contextBudgetStatus: contextBudgetStatus({
        updatedAt: before,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        contextTokenBudget: 200_000,
      }),
      fallbackNoticeSelectedModel: "anthropic/claude-sonnet-4-6",
      fallbackNoticeActiveModel: "anthropic/claude-sonnet-4-6",
      fallbackNoticeReason: "provider temporary failure",
    };

    const result = applyOpenAiSelection(entry);

    expect(result.updated).toBe(true);
    expectRuntimeModelFieldsCleared(entry, before);
    expect(entry.contextTokens).toBeUndefined();
    expect(entry.contextBudgetStatus).toBeUndefined();
    expect(entry.fallbackNoticeSelectedModel).toBeUndefined();
    expect(entry.fallbackNoticeActiveModel).toBeUndefined();
    expect(entry.fallbackNoticeReason).toBeUndefined();
    expect(entry.modelOverrideSource).toBe("user");
  });

  it("clears stale runtime model fields even when override selection is unchanged", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-2",
      updatedAt: before,
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      contextTokens: 160_000,
      contextBudgetStatus: contextBudgetStatus({
        updatedAt: before,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        contextTokenBudget: 200_000,
      }),
    };

    const result = applyOpenAiSelection(entry);

    expect(result.updated).toBe(true);
    expectRuntimeModelFieldsCleared(entry, before);
    expect(entry.contextTokens).toBeUndefined();
    expect(entry.contextBudgetStatus).toBeUndefined();
  });

  it("retains aligned runtime model fields when selection and runtime already match", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-3",
      updatedAt: before,
      modelProvider: "openai",
      model: "gpt-5.4",
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      contextTokens: 200_000,
      contextBudgetStatus: contextBudgetStatus({
        updatedAt: before,
        provider: "openai",
        model: "gpt-5.4",
        contextTokenBudget: 200_000,
      }),
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "openai",
        model: "gpt-5.4",
      },
    });

    expect(result.updated).toBe(true);
    expect(entry.modelProvider).toBe("openai");
    expect(entry.model).toBe("gpt-5.4");
    expect(entry.modelOverrideSource).toBe("user");
    expect(entry.contextTokens).toBe(200_000);
    expect(entry.contextBudgetStatus?.contextTokenBudget).toBe(200_000);
    expect((entry.updatedAt ?? 0) >= before).toBe(true);
  });

  it("clears stale contextTokens when switching back to the default model", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-4",
      updatedAt: before,
      providerOverride: "local",
      modelOverride: "sunapi386/llama-3-lexi-uncensored:8b",
      contextTokens: 4_096,
      contextBudgetStatus: contextBudgetStatus({
        updatedAt: before,
        provider: "local",
        model: "sunapi386/llama-3-lexi-uncensored:8b",
        contextTokenBudget: 4_096,
      }),
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "local",
        model: "llama3.1:8b",
        isDefault: true,
      },
    });

    expect(result.updated).toBe(true);
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.modelOverrideSource).toBeUndefined();
    expect(entry.contextTokens).toBeUndefined();
    expect(entry.contextBudgetStatus).toBeUndefined();
    expect((entry.updatedAt ?? 0) > before).toBe(true);
  });

  it("clears stale runtime model fields when selecting the default model", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-default-runtime",
      updatedAt: before,
      modelProvider: "opencode-go",
      model: "deepseek-v4-pro",
      contextTokens: 64_000,
      contextBudgetStatus: contextBudgetStatus({
        updatedAt: before,
        provider: "opencode-go",
        model: "deepseek-v4-pro",
        contextTokenBudget: 64_000,
      }),
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "opencode-go",
        model: "qwen3.6-plus",
        isDefault: true,
      },
    });

    expect(result.updated).toBe(true);
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.modelOverrideSource).toBeUndefined();
    expect(entry.modelProvider).toBeUndefined();
    expect(entry.model).toBeUndefined();
    expect(entry.contextTokens).toBeUndefined();
    expect(entry.contextBudgetStatus).toBeUndefined();
    expect((entry.updatedAt ?? 0) > before).toBe(true);
  });

  it("marks non-default overrides with the provided source", () => {
    const entry: SessionEntry = {
      sessionId: "sess-5a",
      updatedAt: Date.now() - 5_000,
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
      selectionSource: "auto",
    });

    expect(result.updated).toBe(true);
    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
    expect(entry.modelOverrideSource).toBe("auto");
  });

  it("sets liveModelSwitchPending only when explicitly requested", () => {
    const entry: SessionEntry = {
      sessionId: "sess-5",
      updatedAt: Date.now() - 5_000,
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
    };

    const withoutFlag = applyModelOverrideToSessionEntry({
      entry: { ...entry },
      selection: {
        provider: "openai",
        model: "gpt-5.4",
      },
    });
    expect(withoutFlag.updated).toBe(true);
    expect(entry.liveModelSwitchPending).toBeUndefined();

    const withFlagEntry: SessionEntry = { ...entry };
    const withFlag = applyModelOverrideToSessionEntry({
      entry: withFlagEntry,
      selection: {
        provider: "openai",
        model: "gpt-5.4",
      },
      markLiveSwitchPending: true,
    });
    expect(withFlag.updated).toBe(true);
    expect(withFlagEntry.liveModelSwitchPending).toBe(true);
  });

  it("marks profile-only switches as pending when requested", () => {
    const entry: SessionEntry = {
      sessionId: "sess-profile-switch",
      updatedAt: Date.now() - 5_000,
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      authProfileOverride: "oldprofile",
      authProfileOverrideSource: "user",
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "openai",
        model: "gpt-5.4",
      },
      profileOverride: "newprofile",
      markLiveSwitchPending: true,
    });

    expect(result.updated).toBe(true);
    expect(entry.authProfileOverride).toBe("newprofile");
    expect(entry.liveModelSwitchPending).toBe(true);
  });
});

describe("repairProviderWrappedModelOverride", () => {
  it("restores a provider-wrapped override from aligned runtime model fields", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-openrouter-repair-runtime",
      updatedAt: before,
      providerOverride: "anthropic",
      modelOverride: "claude-haiku-4.5",
      modelOverrideSource: "user",
      modelProvider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      contextTokens: 200_000,
    };

    const result = repairProviderWrappedModelOverride({
      entry,
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
    });

    expect(result.updated).toBe(true);
    expect(entry.providerOverride).toBe("openrouter");
    expect(entry.modelOverride).toBe("anthropic/claude-haiku-4.5");
    expect(entry.modelOverrideSource).toBe("user");
    expect(entry.modelProvider).toBeUndefined();
    expect(entry.model).toBeUndefined();
    expect(entry.contextTokens).toBeUndefined();
    expect((entry.updatedAt ?? 0) > before).toBe(true);
  });

  it("clears a provider-wrapped override that matches the configured default", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-openrouter-repair-default",
      updatedAt: before,
      providerOverride: "anthropic",
      modelOverride: "claude-haiku-4.5",
      modelOverrideSource: "user",
    };

    const result = repairProviderWrappedModelOverride({
      entry,
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-haiku-4.5",
    });

    expect(result.updated).toBe(true);
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.modelOverrideSource).toBeUndefined();
    expect((entry.updatedAt ?? 0) > before).toBe(true);
  });
});
