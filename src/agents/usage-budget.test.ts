import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { withEnvOverride } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.js";
import { USAGE_BUDGET_RECORDED_COST_METADATA_KEY } from "../shared/usage-budget-recorded-cost.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { resetUsageFormatCachesForTest } from "../utils/usage-format.js";
import {
  MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE,
  USAGE_BUDGET_OPERATION_ID_KEY,
} from "./compaction-usage-accounting.js";
import {
  checkAgentUsageBudgetAdmission,
  acquireAgentUsageBudgetAdmission,
  hasAnyActiveAgentUsageBudgetConfig,
  isAgentUsageBudgetError,
  loadAgentUsageBudgetLedgerAccountedEntries,
  recordAgentUsageBudgetAdmissionResult,
  resolveAgentUsageBudgetConfig,
  resolveUsageBudgetCostMultiplierUsage,
  resolveUsageBudgetWindow,
} from "./usage-budget.js";

const PROVIDER = "budget-test";
const MODEL = "priced";
type TestModelCost = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  tieredPricing?: Array<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    range: [number, number] | [number];
  }>;
};

function configWithBudget(
  usageBudget: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["usageBudget"],
  modelCost?: TestModelCost,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        usageBudget,
      },
    },
    ...(modelCost
      ? {
          models: {
            providers: {
              [PROVIDER]: {
                baseUrl: "https://example.invalid",
                models: [
                  {
                    id: MODEL,
                    name: MODEL,
                    reasoning: false,
                    input: ["text"],
                    cost: {
                      input: modelCost.input,
                      output: modelCost.output,
                      cacheRead: modelCost.cacheRead ?? 0,
                      cacheWrite: modelCost.cacheWrite ?? 0,
                      ...(modelCost.tieredPricing
                        ? { tieredPricing: modelCost.tieredPricing }
                        : {}),
                    },
                    contextWindow: 128_000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        }
      : {}),
  };
}

async function writeTranscript(params: {
  agentId?: string;
  fileName?: string;
  entries: Array<Record<string, unknown>>;
}): Promise<void> {
  const dir = resolveSessionTranscriptsDirForAgent(params.agentId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, params.fileName ?? "budget-test.jsonl");
  await fs.writeFile(
    filePath,
    `${params.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  const newestTimestamp = params.entries.reduce<number | undefined>((current, entry) => {
    const message = entry.message as { timestamp?: unknown } | undefined;
    const raw = entry.timestamp ?? message?.timestamp;
    const timestamp =
      typeof raw === "number" && Number.isFinite(raw)
        ? raw
        : typeof raw === "string"
          ? Date.parse(raw)
          : undefined;
    return timestamp === undefined || (current !== undefined && current >= timestamp)
      ? current
      : timestamp;
  }, undefined);
  if (newestTimestamp !== undefined) {
    const date = new Date(newestTimestamp);
    await fs.utimes(filePath, date, date);
  }
}

function assistantUsageEntry(params: {
  id?: string;
  timestamp: number;
  provider?: string;
  model?: string;
  input?: number;
  output?: number;
  costTotal?: number;
  usageBudgetRecordedCost?: boolean;
  usageBudgetRecordedCostKind?:
    | "estimated-model-call-cost"
    | "provider-billed-model-call-cost"
    | "model-call-cost-multiplier";
  usageBudgetUnpriceableCost?: boolean;
  costMultiplier?: number;
  usageBudgetOperationId?: string;
}): Record<string, unknown> {
  const input = params.input ?? 0;
  const output = params.output ?? 0;
  return {
    ...(params.id ? { id: params.id } : {}),
    message: {
      role: "assistant",
      timestamp: params.timestamp,
      ...(params.usageBudgetOperationId
        ? { [USAGE_BUDGET_OPERATION_ID_KEY]: params.usageBudgetOperationId }
        : {}),
      provider: params.provider ?? PROVIDER,
      model: params.model ?? MODEL,
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        ...(params.costTotal !== undefined
          ? {
              cost: {
                input: params.costTotal,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: params.costTotal,
              },
              usageBudgetRecordedCost: {
                schemaVersion: 1,
                kind: "estimated-model-call-cost",
                costMultiplier: 1,
              },
            }
          : {}),
        ...(params.usageBudgetRecordedCost
          ? {
              usageBudgetRecordedCost: {
                schemaVersion: 1,
                kind: params.usageBudgetRecordedCostKind ?? "estimated-model-call-cost",
                costMultiplier: params.costMultiplier ?? 1,
              },
            }
          : {}),
        ...(params.usageBudgetUnpriceableCost
          ? {
              usageBudgetRecordedCost: {
                schemaVersion: 1,
                kind: "unpriceable-model-call-cost",
                reason: "capacity-billed-service-tier",
              },
            }
          : {}),
      },
    },
  };
}

function modelCallUsageAccountingEntry(params: {
  id?: string;
  timestamp: number;
  provider?: string;
  model?: string;
  input?: number;
  output?: number;
  costTotal?: number;
  usageBudgetBridge?: boolean;
  usageBudgetOperationId?: string;
}): Record<string, unknown> {
  return {
    type: "custom",
    customType: MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE,
    ...(params.id ? { id: params.id } : {}),
    timestamp: new Date(params.timestamp).toISOString(),
    appendMode: "side",
    data: {
      schemaVersion: 1,
      usageBudgetBridge: params.usageBudgetBridge ?? true,
      ...(params.usageBudgetOperationId
        ? { [USAGE_BUDGET_OPERATION_ID_KEY]: params.usageBudgetOperationId }
        : {}),
      message: {
        role: "assistant",
        content: [],
        provider: params.provider ?? PROVIDER,
        model: params.model ?? MODEL,
        usage: {
          input: params.input ?? 0,
          output: params.output ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
          ...(params.costTotal !== undefined
            ? {
                cost: {
                  input: params.costTotal,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: params.costTotal,
                },
                usageBudgetRecordedCost: {
                  schemaVersion: 1,
                  kind: "estimated-model-call-cost",
                  costMultiplier: 1,
                },
              }
            : {}),
        },
        stopReason: "stop",
        timestamp: params.timestamp,
      },
    },
  };
}

describe("agent usage budgets", () => {
  beforeEach(() => {
    resetUsageFormatCachesForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    resetUsageFormatCachesForTest();
  });

  it("merges defaults with per-agent overrides and supports per-agent disable", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          usageBudget: {
            daily: { tokens: 100, usd: 1 },
            monthly: { tokens: 1000 },
          },
        },
        list: [
          {
            id: "ops",
            usageBudget: {
              daily: { tokens: 50 },
            },
          },
          {
            id: "unmetered",
            usageBudget: { enabled: false },
          },
        ],
      },
    };

    expect(resolveAgentUsageBudgetConfig({ config: cfg, agentId: "ops" })).toEqual({
      daily: { tokens: 50, usd: 1 },
      monthly: { tokens: 1000 },
    });
    expect(resolveAgentUsageBudgetConfig({ config: cfg, agentId: "unmetered" })).toBeUndefined();
  });

  it("applies per-agent overrides to omitted implicit main agents", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          usageBudget: {
            daily: { tokens: 100 },
          },
        },
        list: [
          {
            id: "main",
            usageBudget: { enabled: false },
          },
        ],
      },
    };

    expect(resolveAgentUsageBudgetConfig({ config: cfg })).toBeUndefined();
  });

  it("applies per-agent overrides to the configured default agent", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          usageBudget: {
            daily: { tokens: 100 },
          },
        },
        list: [
          {
            id: "ops",
            default: true,
            usageBudget: { enabled: false },
          },
        ],
      },
    };

    expect(resolveAgentUsageBudgetConfig({ config: cfg })).toBeUndefined();
    expect(hasAnyActiveAgentUsageBudgetConfig(cfg)).toBe(false);
  });

  it("accounts omitted agent ids against the configured default agent", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const config: OpenClawConfig = {
          agents: {
            defaults: {
              usageBudget: {
                daily: { tokens: 100 },
              },
            },
            list: [{ id: "ops", default: true }],
          },
        };

        recordAgentUsageBudgetAdmissionResult({
          config,
          provider: PROVIDER,
          model: MODEL,
          timestampMs: now - 2000,
          usage: { input: 60, output: 0 },
        });
        recordAgentUsageBudgetAdmissionResult({
          config,
          agentId: "ops",
          provider: PROVIDER,
          model: MODEL,
          timestampMs: now - 1000,
          usage: { input: 40, output: 0 },
        });

        expect(
          loadAgentUsageBudgetLedgerAccountedEntries({
            config,
            minStartMs: now - 3000,
          }).map((entry) => entry.totalTokens),
        ).toEqual([60, 40]);
        expect(
          loadAgentUsageBudgetLedgerAccountedEntries({
            config,
            agentId: "main",
            minStartMs: now - 3000,
          }),
        ).toEqual([]);
        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: {
            agentId: "ops",
            reason: "exceeded",
            window: "daily",
            limitKind: "tokens",
          },
        });
      });
    });
  });

  it("uses deterministic UTC daily and monthly reset windows", () => {
    const now = Date.UTC(2026, 6, 15, 12, 30);

    expect(resolveUsageBudgetWindow("daily", now)).toMatchObject({
      startMs: Date.UTC(2026, 6, 15),
      resetAtMs: Date.UTC(2026, 6, 16),
    });
    expect(resolveUsageBudgetWindow("monthly", now)).toMatchObject({
      startMs: Date.UTC(2026, 6, 1),
      resetAtMs: Date.UTC(2026, 7, 1),
    });
  });

  it("accounts component token totals when provider aggregate totals are stale", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "component-total-budget";
        const now = Date.UTC(2026, 6, 15, 12);
        const config = configWithBudget({ daily: { tokens: 100 } });

        recordAgentUsageBudgetAdmissionResult({
          config,
          agentId,
          provider: PROVIDER,
          model: MODEL,
          timestampMs: now - 1000,
          usage: {
            input: 90,
            output: 10,
            totalTokens: 0,
          },
        });

        const entries = loadAgentUsageBudgetLedgerAccountedEntries({
          config,
          agentId,
          minStartMs: now - 2000,
        });
        expect(entries[0]?.totalTokens).toBe(100);
        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("reprices positive provider costs when a dispatch cost multiplier applies", () => {
    const usage = {
      input: 1000,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
    };

    const repriced = resolveUsageBudgetCostMultiplierUsage({
      config: configWithBudget(
        { daily: { usd: 1 } },
        {
          input: 1,
          output: 2,
        },
      ),
      provider: PROVIDER,
      model: MODEL,
      usage,
      costMultiplier: 2,
    });

    expect(repriced).not.toBe(usage);
    expect(repriced?.cost?.total).toBeCloseTo(0.006);
  });

  it("records authoritative evidence for standard-cost budget dispatches", () => {
    const usage = {
      input: 1000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
    };

    const recorded = resolveUsageBudgetCostMultiplierUsage({
      config: configWithBudget({ daily: { usd: 1 } }, { input: 1, output: 1 }),
      provider: PROVIDER,
      model: MODEL,
      usage,
      costMultiplier: 1,
    });

    expect(recorded).not.toBe(usage);
    expect(recorded?.cost?.total).toBeCloseTo(0.001);
    expect(
      (recorded as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toStrictEqual({
      schemaVersion: 1,
      kind: "estimated-model-call-cost",
      costMultiplier: 1,
    });
  });

  it("does not compound usage-budget recorded costs for the same multiplier", () => {
    const usage = {
      input: 1000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const config = configWithBudget(
      { daily: { usd: 1 } },
      {
        input: 1,
        output: 1,
      },
    );

    const recorded = resolveUsageBudgetCostMultiplierUsage({
      config,
      provider: PROVIDER,
      model: MODEL,
      usage,
      costMultiplier: 2,
    });
    const recordedAgain = resolveUsageBudgetCostMultiplierUsage({
      config,
      provider: PROVIDER,
      model: MODEL,
      usage: recorded,
      costMultiplier: 2,
    });

    expect(recordedAgain).toBe(recorded);
    expect(recordedAgain?.cost?.total).toBeCloseTo(0.002);
  });

  it("preserves authoritative recorded costs when the dispatch estimate changes", () => {
    const usage = {
      input: 1000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const config = configWithBudget(
      { daily: { usd: 1 } },
      {
        input: 1,
        output: 1,
      },
    );

    const recorded = resolveUsageBudgetCostMultiplierUsage({
      config,
      provider: PROVIDER,
      model: MODEL,
      usage,
      costMultiplier: 1.75,
    });
    const recordedAgain = resolveUsageBudgetCostMultiplierUsage({
      config,
      provider: PROVIDER,
      model: MODEL,
      usage: recorded,
      costMultiplier: 0.5,
    });

    expect(recordedAgain).toBe(recorded);
    expect(recordedAgain?.cost?.total).toBeCloseTo(0.00175);
  });

  it("preserves unpriceable cost metadata when a dispatch cost multiplier applies", () => {
    const usage = {
      input: 1000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      [USAGE_BUDGET_RECORDED_COST_METADATA_KEY]: {
        schemaVersion: 1,
        kind: "unpriceable-model-call-cost",
        reason: "capacity-billed-service-tier",
      },
    };

    const resolved = resolveUsageBudgetCostMultiplierUsage({
      config: configWithBudget({ daily: { usd: 1 } }, { input: 1, output: 1 }),
      provider: PROVIDER,
      model: MODEL,
      usage,
      costMultiplier: 2,
    });

    expect(resolved).toBe(usage);
    expect(resolved?.cost?.total).toBe(0.001);
    expect(
      (resolved as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toStrictEqual({
      schemaVersion: 1,
      kind: "unpriceable-model-call-cost",
      reason: "capacity-billed-service-tier",
    });
  });

  it("blocks an agent once the UTC daily token budget is exhausted", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [assistantUsageEntry({ timestamp: now - 1000, input: 80, output: 20 })],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("blocks a request whose token reservation would exceed the daily cap", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [assistantUsageEntry({ timestamp: now - 1000, input: 80, output: 15 })],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
            reservation: { inputTokens: 2, outputTokens: 4 },
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("allows a request whose token reservation fits inside the remaining cap", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [assistantUsageEntry({ timestamp: now - 1000, input: 80, output: 15 })],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
            reservation: { inputTokens: 2, outputTokens: 3 },
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("fails closed for token budgets when prior model calls have no usable usage data", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [assistantUsageEntry({ timestamp: now - 1000 })],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "missing_window_usage", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("fails closed for token budgets on provider-attributed failures without usage", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            {
              message: {
                role: "assistant",
                timestamp: now - 1000,
                provider: PROVIDER,
                model: MODEL,
                stopReason: "error",
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "missing_window_usage", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("ignores pre-dispatch usage-budget denial rows during backfill", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            {
              message: {
                role: "assistant",
                timestamp: now - 1000,
                provider: PROVIDER,
                model: MODEL,
                stopReason: "error",
                errorMessage:
                  'Usage budget blocked for agent "main": daily token budget is exhausted (100/100 tokens, resets 2026-07-16T00:00:00.000Z).',
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("deduplicates rotated unmetered model calls by transcript entry id", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const entry = assistantUsageEntry({
          id: "assistant-call-1",
          timestamp: now - 1000,
        });
        await writeTranscript({
          fileName: "session-1.jsonl",
          entries: [entry],
        });
        await writeTranscript({
          fileName: "session-1.jsonl.reset.2026-07-15T12-00-00.000Z",
          entries: [entry],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          details: { missingUsageEntries: 1 },
        });
      });
    });
  });

  it("uses the corrected active transcript copy for admission dedupe by entry id", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const agentId = "corrected-entry-dedupe";
        const activeEntry = assistantUsageEntry({
          id: "assistant-call-1",
          timestamp: now - 1000,
          input: 40,
          output: 20,
        });
        const archivedEntry = assistantUsageEntry({
          id: "assistant-call-1",
          timestamp: now - 1000,
          input: 20,
          output: 10,
        });
        const config = configWithBudget({ daily: { tokens: 70 } });
        await writeTranscript({
          agentId,
          fileName: "session-1.jsonl",
          entries: [activeEntry],
        });
        await writeTranscript({
          agentId,
          fileName: "session-1.jsonl.reset.2026-07-15T12-00-00.000Z",
          entries: [archivedEntry],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();

        const entries = loadAgentUsageBudgetLedgerAccountedEntries({
          agentId,
          minStartMs: now - 60_000,
          config,
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.recordId).toBe("assistant-call-1");
        expect(entries[0]?.totalTokens).toBe(60);
      });
    });
  });

  it("deduplicates copied entry ids across compacted successor transcript lineage", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const agentId = "successor-entry-dedupe";
        const originalFile = "session-original.jsonl";
        const successorFile = "session-successor.jsonl";
        const secondSuccessorFile = "session-successor-2.jsonl";
        const copiedEntry = assistantUsageEntry({
          id: "assistant-call-1",
          timestamp: now - 1000,
          input: 40,
          output: 20,
        });
        const config = configWithBudget({ daily: { tokens: 70 } });
        await writeTranscript({
          agentId,
          fileName: originalFile,
          entries: [
            {
              type: "session",
              id: "session-original",
              timestamp: new Date(now - 2000).toISOString(),
            },
            copiedEntry,
          ],
        });
        await writeTranscript({
          agentId,
          fileName: successorFile,
          entries: [
            {
              type: "session",
              id: "session-successor",
              timestamp: new Date(now - 500).toISOString(),
              parentSession: originalFile,
            },
            copiedEntry,
          ],
        });
        await writeTranscript({
          agentId,
          fileName: secondSuccessorFile,
          entries: [
            {
              type: "session",
              id: "session-successor-2",
              timestamp: new Date(now - 250).toISOString(),
              parentSession: successorFile,
            },
            copiedEntry,
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();

        const entries = loadAgentUsageBudgetLedgerAccountedEntries({
          agentId,
          minStartMs: now - 60_000,
          config,
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.recordId).toBe("assistant-call-1");
        expect(entries[0]?.totalTokens).toBe(60);
      });
    });
  });

  it("keeps persisted transcript ledger dedupe scoped by session identity", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const agentId = "same-entry-distinct-sessions";
        const config = configWithBudget({ daily: { tokens: 100 } });
        await writeTranscript({
          agentId,
          fileName: "session-a.jsonl",
          entries: [
            assistantUsageEntry({
              id: "assistant-call-1",
              timestamp: now - 2000,
              input: 30,
              output: 10,
            }),
          ],
        });
        await writeTranscript({
          agentId,
          fileName: "session-b.jsonl",
          entries: [
            assistantUsageEntry({
              id: "assistant-call-1",
              timestamp: now - 1000,
              input: 20,
              output: 10,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();

        const entries = loadAgentUsageBudgetLedgerAccountedEntries({
          agentId,
          minStartMs: now - 60_000,
          config,
        });
        expect(entries).toHaveLength(2);
        expect(new Set(entries.map((entry) => entry.dedupKey)).size).toBe(2);
        expect(entries.reduce((sum, entry) => sum + entry.totalTokens, 0)).toBe(70);

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 60 } }),
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("counts distinct calls once across persistent cron usage-family rotations", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const agentId = "persistent-cron-family";
        const usageFamilyKey = "agent:main:telegram:direct:42";
        const config = configWithBudget({ daily: { tokens: 70 } });
        const copiedEntryId = "assistant-call-1";
        await writeTranscript({
          agentId,
          fileName: "bound-session.jsonl.reset.2026-07-15T12-00-00.000Z",
          entries: [
            {
              type: "session",
              id: "bound-session",
              timestamp: new Date(now - 4000).toISOString(),
              usageFamilyKey,
              usageFamilySessionIds: ["bound-session"],
            },
            assistantUsageEntry({
              id: copiedEntryId,
              timestamp: now - 3000,
              input: 50,
              output: 0,
            }),
          ],
        });
        await writeTranscript({
          agentId,
          fileName: "bound-session-rotated.jsonl",
          entries: [
            {
              type: "session",
              id: "bound-session-rotated",
              timestamp: new Date(now - 2000).toISOString(),
              usageFamilyKey,
              usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
            },
            assistantUsageEntry({
              id: copiedEntryId,
              timestamp: now - 1000,
              input: 20,
              output: 10,
            }),
            assistantUsageEntry({
              id: "assistant-call-2",
              timestamp: now - 900,
              input: 20,
              output: 30,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });

        const entries = loadAgentUsageBudgetLedgerAccountedEntries({
          agentId,
          minStartMs: now - 60_000,
          config,
        });
        expect(entries.map((entry) => [entry.recordId, entry.totalTokens])).toEqual([
          [copiedEntryId, 30],
          ["assistant-call-2", 50],
        ]);
      });
    });
  });

  it("ignores gateway-injected assistant bookkeeping rows", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            assistantUsageEntry({
              id: "gateway-row",
              timestamp: now - 1000,
              provider: "openclaw",
              model: "gateway-injected",
              input: 200,
              output: 0,
            }),
            assistantUsageEntry({
              id: "provider-row",
              timestamp: now - 900,
              input: 20,
              output: 0,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("counts generic model-call usage accounting rows", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            modelCallUsageAccountingEntry({
              id: "model-call-accounting-1",
              timestamp: now - 1000,
              input: 80,
              output: 20,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("does not double count model-call accounting rows once the assistant row is visible", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            modelCallUsageAccountingEntry({
              id: "model-call-accounting-1",
              timestamp: now - 1000,
              input: 40,
              output: 20,
            }),
            assistantUsageEntry({
              id: "assistant-call-1",
              timestamp: now - 990,
              input: 40,
              output: 20,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("counts standalone model-call accounting rows that only coincide with an assistant row", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            modelCallUsageAccountingEntry({
              id: "standalone-model-call-accounting",
              timestamp: now - 1000,
              input: 40,
              output: 20,
              usageBudgetBridge: false,
            }),
            assistantUsageEntry({
              id: "assistant-call-1",
              timestamp: now - 990,
              input: 40,
              output: 20,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("does not double count model-call accounting rows covered by aggregate compaction usage", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const operationId = "compaction-operation-1";
        await writeTranscript({
          entries: [
            modelCallUsageAccountingEntry({
              id: "model-call-accounting-1",
              timestamp: now - 1000,
              provider: "openai",
              model: "gpt-5.5-priority-dispatch",
              input: 30,
              output: 10,
              costTotal: 0.04,
              usageBudgetOperationId: operationId,
            }),
            modelCallUsageAccountingEntry({
              id: "model-call-accounting-2",
              timestamp: now - 950,
              provider: "openai",
              model: "gpt-5.5-priority-dispatch",
              input: 50,
              output: 10,
              usageBudgetOperationId: operationId,
            }),
            {
              type: "compaction",
              id: "compaction-1",
              timestamp: new Date(now - 900).toISOString(),
              summary: "summary",
              firstKeptEntryId: "user-1",
              tokensBefore: 1000,
              usageAccounting: {
                provider: PROVIDER,
                model: MODEL,
                [USAGE_BUDGET_OPERATION_ID_KEY]: operationId,
                usage: {
                  input: 80,
                  output: 20,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 100,
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 150 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("does not suppress partial aggregate compaction bridge rows in budget windows", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const operationId = "compaction-operation-partial";
        await writeTranscript({
          entries: [
            modelCallUsageAccountingEntry({
              id: "model-call-accounting-1",
              timestamp: now - 1000,
              input: 30,
              output: 10,
              usageBudgetOperationId: operationId,
            }),
            {
              type: "compaction",
              id: "compaction-1",
              timestamp: new Date(now - 900).toISOString(),
              summary: "summary",
              firstKeptEntryId: "user-1",
              tokensBefore: 1000,
              usageAccounting: {
                provider: PROVIDER,
                model: MODEL,
                [USAGE_BUDGET_OPERATION_ID_KEY]: operationId,
                usage: {
                  input: 80,
                  output: 20,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 100,
                  cost: { total: 0.1 },
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 120 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("uses bridge costs for full aggregate compaction reconciliation", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const operationId = "compaction-operation-bridge-cost";
        await writeTranscript({
          entries: [
            modelCallUsageAccountingEntry({
              id: "model-call-accounting-1",
              timestamp: now - 1000,
              input: 30,
              output: 10,
              costTotal: 0.08,
              usageBudgetOperationId: operationId,
            }),
            modelCallUsageAccountingEntry({
              id: "model-call-accounting-2",
              timestamp: now - 950,
              input: 50,
              output: 10,
              costTotal: 0.09,
              usageBudgetOperationId: operationId,
            }),
            {
              type: "compaction",
              id: "compaction-1",
              timestamp: new Date(now - 900).toISOString(),
              summary: "summary",
              firstKeptEntryId: "user-1",
              tokensBefore: 1000,
              usageAccounting: {
                provider: PROVIDER,
                model: MODEL,
                [USAGE_BUDGET_OPERATION_ID_KEY]: operationId,
                usage: {
                  input: 80,
                  output: 20,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 100,
                  cost: { total: 0.01 },
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { usd: 0.1 } }, { input: 1, output: 1 }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "spend" },
        });
      });
    });
  });

  it("fails closed when a full aggregate compaction bridge lacks spend evidence", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const operationId = "compaction-operation-bridge-missing-cost";
        await writeTranscript({
          entries: [
            modelCallUsageAccountingEntry({
              id: "model-call-accounting-1",
              timestamp: now - 1000,
              input: 30,
              output: 10,
              costTotal: 0.08,
              usageBudgetOperationId: operationId,
            }),
            modelCallUsageAccountingEntry({
              id: "model-call-accounting-2",
              timestamp: now - 950,
              provider: "unknown-provider",
              model: "unknown-model",
              input: 50,
              output: 10,
              usageBudgetOperationId: operationId,
            }),
            {
              type: "compaction",
              id: "compaction-1",
              timestamp: new Date(now - 900).toISOString(),
              summary: "summary",
              firstKeptEntryId: "user-1",
              tokensBefore: 1000,
              usageAccounting: {
                provider: PROVIDER,
                model: MODEL,
                [USAGE_BUDGET_OPERATION_ID_KEY]: operationId,
                usage: {
                  input: 80,
                  output: 20,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 100,
                  cost: { total: 0.01 },
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { usd: 1 } }, { input: 1, output: 1 }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "missing_window_cost", window: "daily", limitKind: "spend" },
        });
      });
    });
  });

  it("deduplicates persisted bridge rows before aggregate compaction reconciliation", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "persisted-bridge-aggregate";
        const now = Date.UTC(2026, 6, 15, 12);
        const operationId = "compaction-operation-persisted-bridge";
        const timestamp = now - 1000;
        const config = configWithBudget({ daily: { tokens: 50 } });
        recordAgentUsageBudgetAdmissionResult({
          config,
          agentId,
          provider: PROVIDER,
          model: MODEL,
          timestampMs: timestamp,
          recordId: "model-call-accounting-1",
          usageBudgetBridge: true,
          usageBudgetOperationId: operationId,
          usage: {
            input: 30,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
          },
        });
        await writeTranscript({
          agentId,
          entries: [
            modelCallUsageAccountingEntry({
              id: "model-call-accounting-1",
              timestamp,
              input: 30,
              output: 10,
              usageBudgetOperationId: operationId,
            }),
            {
              type: "compaction",
              id: "compaction-1",
              timestamp: new Date(timestamp + 10).toISOString(),
              summary: "summary",
              firstKeptEntryId: "user-1",
              tokensBefore: 1000,
              usageAccounting: {
                provider: PROVIDER,
                model: MODEL,
                [USAGE_BUDGET_OPERATION_ID_KEY]: operationId,
                usage: {
                  input: 30,
                  output: 10,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 40,
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("uses operation ids instead of timestamp windows for long-running aggregate compactions", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const operationId = "compaction-operation-long";
        await writeTranscript({
          entries: [
            modelCallUsageAccountingEntry({
              id: "model-call-accounting-early",
              timestamp: now - 12 * 60 * 1000,
              input: 80,
              output: 20,
              usageBudgetOperationId: operationId,
            }),
            {
              type: "compaction",
              id: "compaction-late",
              timestamp: new Date(now - 1000).toISOString(),
              summary: "summary",
              firstKeptEntryId: "user-1",
              tokensBefore: 1000,
              usageAccounting: {
                provider: PROVIDER,
                model: MODEL,
                [USAGE_BUDGET_OPERATION_ID_KEY]: operationId,
                usage: {
                  input: 80,
                  output: 20,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 100,
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 150 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("uses operation ids instead of timestamp windows for long-running assistant calls", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const operationId = "model-call-long";
        await writeTranscript({
          entries: [
            modelCallUsageAccountingEntry({
              id: "model-call-accounting-early",
              timestamp: now - 12 * 60 * 1000,
              input: 80,
              output: 20,
              usageBudgetOperationId: operationId,
            }),
            assistantUsageEntry({
              id: "assistant-late",
              timestamp: now - 1000,
              input: 80,
              output: 20,
              usageBudgetOperationId: operationId,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 150 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("charges aggregate compaction usage to the canonical owner UTC budget window", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const resetMs = Date.UTC(2026, 6, 16);
        const now = resetMs + 60_000;
        const operationId = "compaction-operation-reset";
        await writeTranscript({
          entries: [
            modelCallUsageAccountingEntry({
              id: "model-call-before-reset",
              timestamp: resetMs - 1000,
              input: 80,
              output: 20,
              usageBudgetOperationId: operationId,
            }),
            {
              type: "compaction",
              id: "compaction-after-reset",
              timestamp: new Date(resetMs + 1000).toISOString(),
              summary: "summary",
              firstKeptEntryId: "user-1",
              tokensBefore: 1000,
              usageAccounting: {
                provider: PROVIDER,
                model: MODEL,
                [USAGE_BUDGET_OPERATION_ID_KEY]: operationId,
                usage: {
                  input: 80,
                  output: 20,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 100,
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 50 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("charges completed assistant calls to their original UTC budget windows", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const resetMs = Date.UTC(2026, 6, 16);
        const now = resetMs + 60_000;
        const operationId = "model-call-reset";
        await writeTranscript({
          entries: [
            modelCallUsageAccountingEntry({
              id: "model-call-before-reset",
              timestamp: resetMs - 1000,
              input: 80,
              output: 20,
              usageBudgetOperationId: operationId,
            }),
            assistantUsageEntry({
              id: "assistant-after-reset",
              timestamp: resetMs + 1000,
              input: 80,
              output: 20,
              usageBudgetOperationId: operationId,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 50 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("deduplicates aggregate compaction usage across more than sixteen bridge rows", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        const operationId = "compaction-operation-many";
        await writeTranscript({
          entries: [
            ...Array.from({ length: 18 }, (_, index) =>
              modelCallUsageAccountingEntry({
                id: `model-call-accounting-${index + 1}`,
                timestamp: now - 2000 + index * 50,
                input: 1,
                output: 0,
                usageBudgetOperationId: operationId,
              }),
            ),
            {
              type: "compaction",
              id: "compaction-1",
              timestamp: new Date(now - 900).toISOString(),
              summary: "summary",
              firstKeptEntryId: "user-1",
              tokensBefore: 1000,
              usageAccounting: {
                provider: PROVIDER,
                model: MODEL,
                [USAGE_BUDGET_OPERATION_ID_KEY]: operationId,
                usage: {
                  input: 18,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 18,
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 20 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("does not double count a completed call that is pending and persisted", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "pending-persisted";
        const now = Date.UTC(2026, 6, 15, 12);
        const timestamp = now - 1000;
        await writeTranscript({
          agentId,
          entries: [
            assistantUsageEntry({
              id: "assistant-call-1",
              timestamp,
              input: 40,
              output: 20,
            }),
          ],
        });
        recordAgentUsageBudgetAdmissionResult({
          config: configWithBudget({ daily: { tokens: 100 } }),
          agentId,
          provider: PROVIDER,
          model: MODEL,
          timestampMs: timestamp,
          recordId: "assistant-call-1",
          usage: {
            input: 40,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
          },
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("keeps durable ledger deduplication isolated per agent", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const timestampMs = Date.UTC(2026, 6, 15, 12);
        const usage = {
          input: 40,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
        };
        for (const agentId of ["ledger-agent-a", "ledger-agent-b"]) {
          recordAgentUsageBudgetAdmissionResult({
            config: configWithBudget({ daily: { tokens: 100 } }),
            agentId,
            provider: PROVIDER,
            model: MODEL,
            timestampMs,
            recordId: "assistant-call-1",
            usage,
          });
        }

        const agentAEntries = loadAgentUsageBudgetLedgerAccountedEntries({
          agentId: "ledger-agent-a",
          minStartMs: timestampMs - 1,
          config: configWithBudget({ daily: { tokens: 100 } }),
        });
        const agentBEntries = loadAgentUsageBudgetLedgerAccountedEntries({
          agentId: "ledger-agent-b",
          minStartMs: timestampMs - 1,
          config: configWithBudget({ daily: { tokens: 100 } }),
        });

        expect(agentAEntries).toHaveLength(1);
        expect(agentBEntries).toHaveLength(1);
        expect(agentAEntries[0]?.totalTokens).toBe(60);
        expect(agentBEntries[0]?.totalTokens).toBe(60);
      });
    });
  });

  it("backfills legacy transcript rows without ids idempotently", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "legacy-idless";
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          agentId,
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 40,
              output: 20,
            }),
          ],
        });

        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expect(
            checkAgentUsageBudgetAdmission({
              config: configWithBudget({ daily: { tokens: 100 } }),
              agentId,
              provider: PROVIDER,
              model: MODEL,
              nowMs: now,
            }),
          ).resolves.toBeUndefined();
        }

        const entries = loadAgentUsageBudgetLedgerAccountedEntries({
          agentId,
          minStartMs: now - 60_000,
          config: configWithBudget({ daily: { tokens: 100 } }),
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.recordId).toContain("legacy-transcript|");
        expect(entries[0]?.totalTokens).toBe(60);
      });
    });
  });

  it("deduplicates idless legacy transcript rows after reset archival", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "legacy-idless-reset";
        const now = Date.UTC(2026, 6, 15, 12);
        const entry = assistantUsageEntry({
          timestamp: now - 1000,
          input: 40,
          output: 20,
        });
        const config = configWithBudget({ daily: { tokens: 100 } });
        await writeTranscript({
          agentId,
          fileName: "session-1.jsonl",
          entries: [entry],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();

        await writeTranscript({
          agentId,
          fileName: "session-1.jsonl.reset.2026-07-15T12-00-00.000Z",
          entries: [entry],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();

        const entries = loadAgentUsageBudgetLedgerAccountedEntries({
          agentId,
          minStartMs: now - 60_000,
          config,
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.totalTokens).toBe(60);
      });
    });
  });

  it("rescans an explicit current transcript when an existing file grows under an unchanged directory", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "legacy-sibling-growth";
        const now = Date.UTC(2026, 6, 15, 12);
        const config = configWithBudget({ daily: { tokens: 100 } });
        const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
        const activeTranscriptPath = path.join(sessionsDir, "session-1.jsonl");
        const siblingTranscriptPath = path.join(sessionsDir, "session-2.jsonl");
        await writeTranscript({
          agentId,
          fileName: "session-1.jsonl",
          entries: [
            assistantUsageEntry({
              timestamp: now - 3000,
              input: 10,
              output: 10,
            }),
          ],
        });
        await writeTranscript({
          agentId,
          fileName: "session-2.jsonl",
          entries: [
            assistantUsageEntry({
              timestamp: now - 2000,
              input: 10,
              output: 10,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
            transcriptPath: activeTranscriptPath,
          }),
        ).resolves.toBeUndefined();

        const beforeDirStats = await fs.stat(sessionsDir);
        await fs.appendFile(
          siblingTranscriptPath,
          `${JSON.stringify(
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 70,
              output: 20,
            }),
          )}\n`,
          "utf8",
        );
        const appendedDate = new Date(now - 1000);
        await fs.utimes(siblingTranscriptPath, appendedDate, appendedDate);
        await fs.utimes(sessionsDir, beforeDirStats.atime, beforeDirStats.mtime);

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
            transcriptPath: siblingTranscriptPath,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("rescans an appended sibling transcript while the active transcript is unchanged", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "unchanged-active-sibling-growth";
        const now = Date.UTC(2026, 6, 15, 12);
        const config = configWithBudget({ daily: { tokens: 100 } });
        const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
        const activeTranscriptPath = path.join(sessionsDir, "session-active.jsonl");
        const siblingTranscriptPath = path.join(sessionsDir, "session-sibling.jsonl");
        await writeTranscript({
          agentId,
          fileName: "session-active.jsonl",
          entries: [
            assistantUsageEntry({
              timestamp: now - 3000,
              input: 10,
              output: 10,
            }),
          ],
        });
        await writeTranscript({
          agentId,
          fileName: "session-sibling.jsonl",
          entries: [
            assistantUsageEntry({
              timestamp: now - 2000,
              input: 10,
              output: 10,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
            transcriptPath: activeTranscriptPath,
          }),
        ).resolves.toBeUndefined();

        const beforeDirStats = await fs.stat(sessionsDir);
        const initialSiblingStats = await fs.stat(siblingTranscriptPath);
        await fs.appendFile(
          siblingTranscriptPath,
          `${JSON.stringify(
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 70,
              output: 20,
            }),
          )}\n`,
          "utf8",
        );
        const appendedDate = new Date(now - 1000);
        await fs.utimes(siblingTranscriptPath, appendedDate, appendedDate);
        await fs.utimes(sessionsDir, beforeDirStats.atime, beforeDirStats.mtime);

        const createReadStreamSpy = vi.spyOn(nodeFs, "createReadStream");
        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
            transcriptPath: activeTranscriptPath,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
        expect(createReadStreamSpy).toHaveBeenCalledWith(
          siblingTranscriptPath,
          expect.objectContaining({
            start: initialSiblingStats.size,
          }),
        );
      });
    });
  });

  it("rescans the active transcript when an existing file grows without an explicit path", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "legacy-active-growth";
        const now = Date.UTC(2026, 6, 15, 12);
        const config = configWithBudget({ daily: { tokens: 100 } });
        const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
        const transcriptPath = path.join(sessionsDir, "session-1.jsonl");
        await writeTranscript({
          agentId,
          fileName: "session-1.jsonl",
          entries: [
            assistantUsageEntry({
              timestamp: now - 2000,
              input: 40,
              output: 20,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();

        const beforeDirStats = await fs.stat(sessionsDir);
        const initialTranscriptStats = await fs.stat(transcriptPath);
        await fs.appendFile(
          transcriptPath,
          `${JSON.stringify(
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 40,
              output: 20,
            }),
          )}\n`,
          "utf8",
        );
        const appendedDate = new Date(now - 1000);
        await fs.utimes(transcriptPath, appendedDate, appendedDate);
        await fs.utimes(sessionsDir, beforeDirStats.atime, beforeDirStats.mtime);

        const createReadStreamSpy = vi.spyOn(nodeFs, "createReadStream");
        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
        expect(createReadStreamSpy).toHaveBeenCalledWith(
          transcriptPath,
          expect.objectContaining({
            start: initialTranscriptStats.size,
          }),
        );
      });
    });
  });

  it("fully rescans a same-size transcript rewrite instead of reusing append cache", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "same-size-transcript-rewrite";
        const now = Date.UTC(2026, 6, 15, 12);
        const config = configWithBudget({ daily: { tokens: 100 } });
        const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
        const transcriptPath = path.join(sessionsDir, "session-1.jsonl");
        const initialEntry = assistantUsageEntry({
          id: `old-${"o".repeat(80)}`,
          timestamp: now - 2000,
          input: 10,
          output: 10,
        });
        await writeTranscript({
          agentId,
          fileName: "session-1.jsonl",
          entries: [initialEntry],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();

        const initialStats = await fs.stat(transcriptPath);
        const targetLineLength = JSON.stringify(initialEntry).length;
        let replacementId = "new";
        let replacementEntry = assistantUsageEntry({
          id: replacementId,
          timestamp: now - 1000,
          input: 70,
          output: 40,
        });
        while (JSON.stringify(replacementEntry).length < targetLineLength) {
          replacementId += "x";
          replacementEntry = assistantUsageEntry({
            id: replacementId,
            timestamp: now - 1000,
            input: 70,
            output: 40,
          });
        }
        expect(JSON.stringify(replacementEntry).length).toBe(targetLineLength);
        await fs.writeFile(transcriptPath, `${JSON.stringify(replacementEntry)}\n`, "utf8");
        const replacementDate = new Date(now - 1000);
        await fs.utimes(transcriptPath, replacementDate, replacementDate);
        expect((await fs.stat(transcriptPath)).size).toBe(initialStats.size);

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("uses the ledger without rescanning unchanged transcript directories", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "steady-state-budget";
        const now = Date.UTC(2026, 6, 15, 12);
        const config = configWithBudget({ daily: { tokens: 100 } });
        await writeTranscript({
          agentId,
          fileName: "session-1.jsonl",
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 10,
              output: 10,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();

        const readdirSpy = vi.spyOn(fs, "readdir");
        const createReadStreamSpy = vi.spyOn(nodeFs, "createReadStream");
        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();

        expect(readdirSpy).not.toHaveBeenCalled();
        expect(createReadStreamSpy).not.toHaveBeenCalled();
      });
    });
  });

  it("persists in-flight admissions until release", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "in-flight-budget";
        const now = Date.UTC(2026, 6, 15, 12);
        const config = configWithBudget({ daily: { tokens: 100 } });

        const release = await acquireAgentUsageBudgetAdmission({
          config,
          agentId,
          provider: PROVIDER,
          model: MODEL,
          nowMs: now,
        });
        expect(release?.timestampMs).toBe(now);

        const inFlightEntries = loadAgentUsageBudgetLedgerAccountedEntries({
          config,
          agentId,
          minStartMs: now - 1,
        });
        expect(inFlightEntries).toMatchObject([
          {
            source: "model_call_custom",
            totalTokens: 0,
            missingTokenUsageEntries: 1,
          },
        ]);

        await release?.();

        expect(
          loadAgentUsageBudgetLedgerAccountedEntries({
            config,
            agentId,
            minStartMs: now - 1,
          }),
        ).toEqual([]);
      });
    });
  });

  it("keeps in-flight admissions when result persistence fails before release", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "in-flight-record-failure-budget";
        const now = Date.UTC(2026, 6, 15, 12);
        const config = configWithBudget({ daily: { tokens: 100 } });

        const release = await acquireAgentUsageBudgetAdmission({
          config,
          agentId,
          provider: PROVIDER,
          model: MODEL,
          nowMs: now,
        });

        await release?.({ preserveInFlight: true });

        expect(
          loadAgentUsageBudgetLedgerAccountedEntries({
            config,
            agentId,
            minStartMs: now - 1,
          }),
        ).toMatchObject([
          {
            source: "model_call_custom",
            totalTokens: 0,
            missingTokenUsageEntries: 1,
          },
        ]);
      });
    });
  });

  it("reconciles in-flight admissions when the result records before release", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "in-flight-result-budget";
        const now = Date.UTC(2026, 6, 15, 12);
        const usageBudgetOperationId = "usage-budget-operation-1";
        const config = configWithBudget({ daily: { tokens: 100 } });

        const release = await acquireAgentUsageBudgetAdmission({
          config,
          agentId,
          provider: PROVIDER,
          model: MODEL,
          nowMs: now,
          usageBudgetOperationId,
        });
        recordAgentUsageBudgetAdmissionResult({
          config,
          agentId,
          provider: PROVIDER,
          model: MODEL,
          timestampMs: now + 1,
          recordId: "completed-record",
          usageBudgetBridge: true,
          usageBudgetOperationId,
          usage: {
            input: 4,
            output: 6,
            cacheRead: 0,
            cacheWrite: 0,
          },
        });

        const entriesBeforeRelease = loadAgentUsageBudgetLedgerAccountedEntries({
          config,
          agentId,
          minStartMs: now - 1,
        });
        expect(entriesBeforeRelease).toMatchObject([
          {
            recordId: "completed-record",
            totalTokens: 10,
            missingTokenUsageEntries: 0,
            usageBudgetOperationId,
          },
        ]);

        await release?.();

        expect(
          loadAgentUsageBudgetLedgerAccountedEntries({
            config,
            agentId,
            minStartMs: now - 1,
          }),
        ).toMatchObject([
          {
            recordId: "completed-record",
            totalTokens: 10,
            missingTokenUsageEntries: 0,
            usageBudgetOperationId,
          },
        ]);
      });
    });
  });

  it("records completed in-flight operations in the admitted reset window", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "in-flight-reset-window-budget";
        const beforeReset = Date.UTC(2026, 6, 15, 23, 59, 59, 999);
        const afterReset = Date.UTC(2026, 6, 16, 0, 0, 0, 1);
        const usageBudgetOperationId = "usage-budget-reset-window-operation";
        const config = configWithBudget({ daily: { tokens: 100 } });
        const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(beforeReset);

        const release = await acquireAgentUsageBudgetAdmission({
          config,
          agentId,
          provider: PROVIDER,
          model: MODEL,
          usageBudgetOperationId,
        });
        dateNowSpy.mockReturnValue(afterReset);
        recordAgentUsageBudgetAdmissionResult({
          config,
          agentId,
          provider: PROVIDER,
          model: MODEL,
          recordId: "completed-reset-window-record",
          usageBudgetBridge: true,
          usageBudgetOperationId,
          usage: {
            input: 90,
            output: 10,
          },
        });

        await release?.();

        const entries = loadAgentUsageBudgetLedgerAccountedEntries({
          config,
          agentId,
          minStartMs: beforeReset - 1,
        });
        expect(entries).toMatchObject([
          {
            recordId: "completed-reset-window-record",
            timestampMs: beforeReset,
            totalTokens: 100,
            usageBudgetOperationId,
          },
        ]);
        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: beforeReset,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: afterReset,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("backfills usage from a configured custom session store directory", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "custom-store-budget";
        const now = Date.UTC(2026, 6, 15, 12);
        const customSessionsDir = path.join(stateDir, "custom-sessions", agentId);
        const customStorePath = path.join(
          stateDir,
          "custom-sessions",
          "{agentId}",
          "sessions.json",
        );
        const transcriptPath = path.join(customSessionsDir, "custom-session.jsonl");
        await fs.mkdir(customSessionsDir, { recursive: true });
        await fs.writeFile(
          transcriptPath,
          `${JSON.stringify(
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 40,
              output: 20,
            }),
          )}\n`,
          "utf8",
        );
        const entryDate = new Date(now - 1000);
        await fs.utimes(transcriptPath, entryDate, entryDate);

        await expect(
          checkAgentUsageBudgetAdmission({
            config: {
              ...configWithBudget({ daily: { tokens: 50 } }),
              session: { store: customStorePath },
            },
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("fails closed when a custom session store templates only the filename", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "filename-template-budget";
        const now = Date.UTC(2026, 6, 15, 12);
        const sharedSessionsDir = path.join(stateDir, "shared-sessions");
        const sharedStorePath = path.join(sharedSessionsDir, "sessions-{agentId}.json");
        const transcriptPath = path.join(sharedSessionsDir, "shared-session.jsonl");
        await fs.mkdir(sharedSessionsDir, { recursive: true });
        await fs.writeFile(
          transcriptPath,
          `${JSON.stringify(
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 40,
              output: 20,
            }),
          )}\n`,
          "utf8",
        );
        const entryDate = new Date(now - 1000);
        await fs.utimes(transcriptPath, entryDate, entryDate);

        await expect(
          checkAgentUsageBudgetAdmission({
            config: {
              ...configWithBudget({ daily: { tokens: 50 } }),
              session: { store: sharedStorePath },
            },
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "scan_failed" },
        });
      });
    });
  });

  it("fails closed for unscoped shared session stores", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "ops-budget";
        const now = Date.UTC(2026, 6, 15, 12);
        const sharedSessionsDir = path.join(stateDir, "shared-sessions");
        const sharedStorePath = path.join(sharedSessionsDir, "sessions.json");
        const transcriptPath = path.join(sharedSessionsDir, "main-session.jsonl");
        await fs.mkdir(sharedSessionsDir, { recursive: true });
        await fs.writeFile(
          transcriptPath,
          `${JSON.stringify(
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 40,
              output: 20,
            }),
          )}\n`,
          "utf8",
        );
        const entryDate = new Date(now - 1000);
        await fs.utimes(transcriptPath, entryDate, entryDate);

        await expect(
          checkAgentUsageBudgetAdmission({
            config: {
              ...configWithBudget({ daily: { tokens: 50 } }),
              session: { store: sharedStorePath },
            },
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "scan_failed" },
        });

        const entries = loadAgentUsageBudgetLedgerAccountedEntries({
          config: configWithBudget({ daily: { tokens: 50 } }),
          agentId,
          minStartMs: resolveUsageBudgetWindow("daily", now).startMs,
        });
        expect(entries).toHaveLength(0);
      });
    });
  });

  it("does not partially import an explicit transcript from an unscoped shared session store", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "shared-active-budget";
        const now = Date.UTC(2026, 6, 15, 12);
        const sharedSessionsDir = path.join(stateDir, "shared-sessions");
        const sharedStorePath = path.join(sharedSessionsDir, "sessions.json");
        const activeTranscriptPath = path.join(sharedSessionsDir, "active-session.jsonl");
        const siblingTranscriptPath = path.join(sharedSessionsDir, "other-session.jsonl");
        await fs.mkdir(sharedSessionsDir, { recursive: true });
        await fs.writeFile(
          activeTranscriptPath,
          `${JSON.stringify(
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 10,
              output: 10,
            }),
          )}\n`,
          "utf8",
        );
        await fs.writeFile(
          siblingTranscriptPath,
          `${JSON.stringify(
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 40,
              output: 20,
            }),
          )}\n`,
          "utf8",
        );
        const entryDate = new Date(now - 1000);
        await fs.utimes(activeTranscriptPath, entryDate, entryDate);
        await fs.utimes(siblingTranscriptPath, entryDate, entryDate);

        await expect(
          checkAgentUsageBudgetAdmission({
            config: {
              ...configWithBudget({ daily: { tokens: 50 } }),
              session: { store: sharedStorePath },
            },
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
            transcriptPath: activeTranscriptPath,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "scan_failed" },
        });

        const entries = loadAgentUsageBudgetLedgerAccountedEntries({
          config: configWithBudget({ daily: { tokens: 50 } }),
          agentId,
          minStartMs: resolveUsageBudgetWindow("daily", now).startMs,
        });
        expect(entries).toHaveLength(0);
      });
    });
  });

  it("backfills transcript rows added after an earlier empty budget scan", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "budget-reenabled";
        const now = Date.UTC(2026, 6, 15, 12);
        const config = configWithBudget({ daily: { tokens: 50 } });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();

        await writeTranscript({
          agentId,
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 40,
              output: 20,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("fails closed when a budget transcript contains malformed JSONL", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "malformed-transcript-budget";
        const now = Date.UTC(2026, 6, 15, 12);
        const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
        const transcriptPath = path.join(sessionsDir, "session-1.jsonl");
        await fs.mkdir(sessionsDir, { recursive: true });
        await fs.writeFile(
          transcriptPath,
          `${JSON.stringify(
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 10,
              output: 10,
            }),
          )}\n{"type":"assistant","message":`,
          "utf8",
        );
        const transcriptDate = new Date(now - 1000);
        await fs.utimes(transcriptPath, transcriptDate, transcriptDate);

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
            transcriptPath,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "scan_failed" },
        });
      });
    });
  });

  it("fails closed when usage-budget ledger storage is not writable", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      const blockedStateDir = path.join(stateDir, "blocked-state");
      await fs.writeFile(blockedStateDir, "not a directory");
      await withEnvOverride({ OPENCLAW_STATE_DIR: blockedStateDir }, async () => {
        try {
          recordAgentUsageBudgetAdmissionResult({
            config: configWithBudget({ daily: { tokens: 100 } }),
            agentId: "ledger-write-failure",
            provider: PROVIDER,
            model: MODEL,
            timestampMs: Date.UTC(2026, 6, 15, 12),
            recordId: "failed-record",
            usage: {
              input: 1,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          });
          throw new Error("expected ledger write to fail");
        } catch (error) {
          expect(error).toMatchObject({
            code: "agent_usage_budget_blocked",
            details: { reason: "record_failed" },
          });
        }
      });
    });
  });

  it("keeps durable usage budget totals after transcript cleanup removes the source file", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "ledger-retention";
        const now = Date.UTC(2026, 6, 15, 12);
        const timestamp = now - 10 * 60 * 1000;
        const config = configWithBudget({ daily: { tokens: 50 } });
        recordAgentUsageBudgetAdmissionResult({
          config,
          agentId,
          provider: PROVIDER,
          model: MODEL,
          timestampMs: timestamp,
          recordId: "assistant-call-1",
          usage: {
            input: 40,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
          },
        });
        await writeTranscript({
          agentId,
          entries: [
            assistantUsageEntry({
              id: "assistant-call-1",
              timestamp,
              input: 40,
              output: 20,
            }),
          ],
        });
        await fs.rm(resolveSessionTranscriptsDirForAgent(agentId), {
          recursive: true,
          force: true,
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("aborts a queued usage-budget admission without keeping the queue blocked", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const config = configWithBudget({ daily: { tokens: 10_000 } });
        const agentId = "queued-abort-agent";
        const firstRelease = await acquireAgentUsageBudgetAdmission({
          config,
          agentId,
          provider: PROVIDER,
          model: MODEL,
        });
        expect(firstRelease).toBeDefined();

        const controller = new AbortController();
        const queued = acquireAgentUsageBudgetAdmission({
          config,
          agentId,
          provider: PROVIDER,
          model: MODEL,
          signal: controller.signal,
        });
        controller.abort(new Error("stop queued admission"));

        await expect(queued).rejects.toMatchObject({
          name: "AbortError",
          message: "stop queued admission",
        });
        const third = acquireAgentUsageBudgetAdmission({
          config,
          agentId,
          provider: PROVIDER,
          model: MODEL,
        });
        await expect(
          Promise.race([
            third.then(
              () => "resolved" as const,
              () => "rejected" as const,
            ),
            delay(25).then(() => "pending" as const),
          ]),
        ).resolves.toBe("pending");

        await firstRelease?.();

        const thirdRelease = await third;
        expect(thirdRelease).toBeDefined();
        await thirdRelease?.();
      });
    });
  });

  it("reconciles pending entries with persisted calls one-to-one", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "pending-one-to-one";
        const now = Date.UTC(2026, 6, 15, 12);
        const timestamp = now - 1000;
        await writeTranscript({
          agentId,
          entries: [
            assistantUsageEntry({
              id: "assistant-call-1",
              timestamp,
              input: 40,
              output: 20,
            }),
          ],
        });
        for (const id of [1, 2]) {
          recordAgentUsageBudgetAdmissionResult({
            config: configWithBudget({ daily: { tokens: 100 } }),
            agentId,
            provider: PROVIDER,
            model: MODEL,
            timestampMs: id === 1 ? timestamp : timestamp + id,
            recordId: `assistant-call-${id}`,
            usage: {
              input: 40,
              output: 20,
              cacheRead: 0,
              cacheWrite: 0,
            },
          });
        }

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          details: { reason: "exceeded", used: 120 },
        });
      });
    });
  });

  it("reconciles aggregate persisted accounting with pending component calls", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "pending-aggregate";
        const now = Date.UTC(2026, 6, 15, 12);
        const timestamp = now - 1000;
        const operationId = "pending-aggregate-operation";
        await writeTranscript({
          agentId,
          entries: [
            {
              type: "compaction",
              id: "compaction-1",
              timestamp: new Date(timestamp).toISOString(),
              summary: "summary",
              firstKeptEntryId: "user-1",
              tokensBefore: 1000,
              usageAccounting: {
                provider: PROVIDER,
                model: MODEL,
                [USAGE_BUDGET_OPERATION_ID_KEY]: operationId,
                usage: {
                  input: 80,
                  output: 20,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 100,
                },
              },
            },
          ],
        });
        for (const [index, usage] of [
          { input: 30, output: 10, cacheRead: 0, cacheWrite: 0 },
          { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 },
        ].entries()) {
          recordAgentUsageBudgetAdmissionResult({
            config: configWithBudget({ daily: { tokens: 150 } }),
            agentId,
            provider: PROVIDER,
            model: MODEL,
            timestampMs: timestamp,
            recordId: `model-call-accounting-${index + 1}`,
            usageBudgetBridge: true,
            usageBudgetOperationId: operationId,
            usage,
          });
        }

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 150 } }),
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("keeps record failures blocking after pending entries age out until the reset window", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "record-failure-sentinel";
        const now = Date.UTC(2026, 6, 15, 12);
        const cfg = configWithBudget({ daily: { tokens: 1_000 }, monthly: {} });
        const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
        await fs.mkdir(databasePath, { recursive: true });

        expect(() =>
          recordAgentUsageBudgetAdmissionResult({
            config: cfg,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            timestampMs: now,
            recordId: "failed-record",
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
            },
          }),
        ).toThrow(/could not persist model-call usage/);

        await fs.rm(databasePath, { recursive: true, force: true });
        closeOpenClawStateDatabaseForTest();

        await expect(
          checkAgentUsageBudgetAdmission({
            config: cfg,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: now + 6 * 60 * 1000,
          }),
        ).rejects.toMatchObject({
          details: { reason: "record_failed" },
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: cfg,
            agentId,
            provider: PROVIDER,
            model: MODEL,
            nowMs: Date.UTC(2026, 6, 16, 0, 0, 1),
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("counts branch summary usage accounting toward agent budgets", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            {
              type: "branch_summary",
              id: "branch-summary-1",
              timestamp: new Date(now - 1000).toISOString(),
              fromId: "user-1",
              summary: "summary",
              usageAccounting: {
                provider: PROVIDER,
                model: MODEL,
                usage: {
                  input: 80,
                  output: 20,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 100,
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "tokens" },
        });
      });
    });
  });

  it("does not accept unmarked spend as token or cost evidence", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            {
              message: {
                role: "assistant",
                timestamp: now - 1000,
                provider: PROVIDER,
                model: MODEL,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "missing_window_usage", window: "daily", limitKind: "tokens" },
        });
        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { usd: 1 } }, { input: 1, output: 1 }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "missing_window_cost", window: "daily", limitKind: "spend" },
        });
      });
    });
  });

  it("fails closed for spend budgets when selected model pricing is missing", async () => {
    await expect(
      checkAgentUsageBudgetAdmission({
        config: configWithBudget({ daily: { usd: 1 } }),
        provider: PROVIDER,
        model: MODEL,
        nowMs: Date.UTC(2026, 6, 15, 12),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isAgentUsageBudgetError(error)).toBe(true);
      expect((error as Error).message).toContain("pricing is missing");
      return true;
    });
  });

  it("fails closed for spend budgets when reservation cost is explicitly unpriceable", async () => {
    await expect(
      checkAgentUsageBudgetAdmission({
        config: configWithBudget({ daily: { usd: 1 } }, { input: 1, output: 1 }),
        provider: PROVIDER,
        model: MODEL,
        nowMs: Date.UTC(2026, 6, 15, 12),
        reservation: { inputTokens: 10, outputTokens: 1 },
        reservationCostKnown: false,
      }),
    ).rejects.toMatchObject({
      code: "agent_usage_budget_blocked",
      details: { reason: "missing_model_pricing" },
    });
  });

  it("reserves prompt spend at the highest possible cache price", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget(
              { daily: { usd: 0.000006 } },
              { input: 5, output: 1, cacheRead: 0.5, cacheWrite: 6.25 },
            ),
            provider: PROVIDER,
            model: MODEL,
            nowMs: Date.UTC(2026, 6, 15, 12),
            reservation: { inputTokens: 1 },
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "spend" },
        });
      });
    });
  });

  it("allows token-only budgets when reservation cost is explicitly unpriceable", async () => {
    await expect(
      checkAgentUsageBudgetAdmission({
        config: configWithBudget({ daily: { tokens: 100 } }, { input: 1, output: 1 }),
        provider: PROVIDER,
        model: MODEL,
        nowMs: Date.UTC(2026, 6, 15, 12),
        reservation: { inputTokens: 10, outputTokens: 1 },
        reservationCostKnown: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("recognizes verified OpenRouter free routes as known zero-cost pricing", async () => {
    await expect(
      checkAgentUsageBudgetAdmission({
        config: {
          agents: {
            defaults: {
              usageBudget: { daily: { usd: 1 } },
            },
          },
          models: {
            providers: {
              openrouter: {
                baseUrl: "https://openrouter.ai/api/v1",
                models: [
                  {
                    id: "openrouter/free",
                    name: "OpenRouter Free",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        },
        provider: "openrouter",
        model: "openrouter/free",
        nowMs: Date.UTC(2026, 6, 15, 12),
        reservation: { inputTokens: 10, outputTokens: 1 },
      }),
    ).resolves.toBeUndefined();
  });

  it("still fails closed for unverified all-zero model pricing", async () => {
    await expect(
      checkAgentUsageBudgetAdmission({
        config: configWithBudget({ daily: { usd: 1 } }, { input: 0, output: 0 }),
        provider: PROVIDER,
        model: MODEL,
        nowMs: Date.UTC(2026, 6, 15, 12),
      }),
    ).rejects.toMatchObject({
      code: "agent_usage_budget_blocked",
      details: { reason: "missing_model_pricing" },
    });
  });

  it("allows spend budget admission once late pricing can price prior usage", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 100,
              output: 100,
              usageBudgetRecordedCost: true,
              usageBudgetRecordedCostKind: "model-call-cost-multiplier",
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { usd: 1 } }, { input: 1, output: 1 }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("conservatively prices aggregate-only transcript usage for spend budgets", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            {
              message: {
                role: "assistant",
                timestamp: now - 1000,
                provider: PROVIDER,
                model: MODEL,
                usage: {
                  totalTokens: 1_000_000,
                  usageBudgetRecordedCost: {
                    schemaVersion: 1,
                    kind: "model-call-cost-multiplier",
                    costMultiplier: 1,
                  },
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { usd: 1 } }, { input: 0.25, output: 2 }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "spend" },
        });
      });
    });
  });

  it("reprices multiplier-marked cost when tiered pricing is configured", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 1000,
              output: 0,
              costTotal: 100,
              usageBudgetRecordedCost: true,
              usageBudgetRecordedCostKind: "model-call-cost-multiplier",
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget(
              { daily: { usd: 1 } },
              {
                input: 1,
                output: 1,
                tieredPricing: [
                  {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    range: [0],
                  },
                ],
              },
            ),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("fails closed on unmarked historical costs whose dispatch tier cannot be proven", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            {
              message: {
                role: "assistant",
                timestamp: now - 1000,
                provider: PROVIDER,
                model: MODEL,
                usage: {
                  input: 1000,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { total: 0.001 },
                },
              },
            },
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { usd: 1 } }, { input: 1, output: 1 }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "missing_window_cost", window: "daily", limitKind: "spend" },
        });
      });
    });
  });

  it("preserves usage-budget recorded cost when tiered pricing already includes a multiplier", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 10,
              output: 0,
              costTotal: 0.00002,
              usageBudgetRecordedCost: true,
              costMultiplier: 2,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget(
              { daily: { usd: 0.000015 } },
              {
                input: 1,
                output: 1,
                tieredPricing: [
                  {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    range: [0],
                  },
                ],
              },
            ),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "spend" },
        });
      });
    });
  });

  it("trusts provider-billed recorded cost when tiered local pricing is cheaper", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 10,
              output: 0,
              costTotal: 0.0042,
              usageBudgetRecordedCost: true,
              usageBudgetRecordedCostKind: "provider-billed-model-call-cost",
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget(
              { daily: { usd: 0.002 } },
              {
                input: 1,
                output: 1,
                tieredPricing: [
                  {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    range: [0],
                  },
                ],
              },
            ),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "spend" },
        });
      });
    });
  });

  it("trusts provider-billed zero cost when local pricing is nonzero", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 10,
              output: 0,
              costTotal: 0,
              usageBudgetRecordedCost: true,
              usageBudgetRecordedCostKind: "provider-billed-model-call-cost",
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { usd: 0.000001 } }, { input: 100, output: 100 }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("records provider-accounted zero-token usage without blocking token budgets", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 0,
              output: 0,
              costTotal: 0,
              usageBudgetRecordedCost: true,
              usageBudgetRecordedCostKind: "provider-billed-model-call-cost",
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 1 } }, { input: 1, output: 1 }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  it("applies recorded cost multipliers to tiered local pricing without trusting flat totals", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 200_000,
              output: 0,
              costTotal: 0.2,
              usageBudgetRecordedCost: true,
              usageBudgetRecordedCostKind: "model-call-cost-multiplier",
              costMultiplier: 2,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget(
              { daily: { usd: 3 } },
              {
                input: 1,
                output: 1,
                tieredPricing: [
                  {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    range: [0, 128_000],
                  },
                  {
                    input: 10,
                    output: 10,
                    cacheRead: 0,
                    cacheWrite: 0,
                    range: [128_000],
                  },
                ],
              },
            ),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "spend" },
        });
      });
    });
  });

  it("does not treat marked zero cost as recorded spend evidence", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 10,
              output: 0,
              costTotal: 0,
              usageBudgetRecordedCost: true,
              costMultiplier: 2,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget(
              { daily: { usd: 0.000005 } },
              {
                input: 1,
                output: 1,
                tieredPricing: [
                  {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    range: [0],
                  },
                ],
              },
            ),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "exceeded", window: "daily", limitKind: "spend" },
        });
      });
    });
  });

  it("blocks spend budgets when prior in-window usage still lacks cost data", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              provider: "unknown-provider",
              model: "unknown-model",
              input: 100,
              output: 1,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { usd: 1 } }, { input: 1, output: 1 }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "missing_window_cost", window: "daily", limitKind: "spend" },
        });
      });
    });
  });

  it("blocks spend budgets when prior in-window usage has unpriceable final cost", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = Date.UTC(2026, 6, 15, 12);
        await writeTranscript({
          entries: [
            assistantUsageEntry({
              timestamp: now - 1000,
              input: 100,
              output: 1,
              costTotal: 0.001,
              usageBudgetUnpriceableCost: true,
            }),
          ],
        });

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { usd: 1 } }, { input: 1, output: 1 }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: now,
          }),
        ).rejects.toMatchObject({
          code: "agent_usage_budget_blocked",
          details: { reason: "missing_window_cost", window: "daily", limitKind: "spend" },
        });
      });
    });
  });

  it("fails closed when prior usage transcripts cannot be scanned", async () => {
    await withTempDir({ prefix: "openclaw-usage-budget-" }, async (stateDir) => {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await fs.mkdir(resolveSessionTranscriptsDirForAgent(undefined), { recursive: true });
        const denied = Object.assign(new Error("permission denied: /secret/openclaw/state"), {
          code: "EACCES",
        });
        vi.spyOn(nodeFs.promises, "readdir").mockRejectedValueOnce(denied);

        await expect(
          checkAgentUsageBudgetAdmission({
            config: configWithBudget({ daily: { tokens: 100 } }),
            provider: PROVIDER,
            model: MODEL,
            nowMs: Date.UTC(2026, 6, 15, 12),
          }),
        ).rejects.toSatisfy((error: unknown) => {
          expect(error).toMatchObject({
            code: "agent_usage_budget_blocked",
            details: { reason: "scan_failed" },
          });
          expect((error as Error).message).not.toContain("/secret/openclaw/state");
          return true;
        });
      });
    });
  });
});
