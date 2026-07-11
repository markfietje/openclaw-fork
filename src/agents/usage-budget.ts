import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { resolveStateDir } from "../config/paths.js";
import {
  isPrimarySessionTranscriptFileName,
  isUsageCountedSessionTranscriptFileName,
  parseSessionArchiveTimestamp,
  parseUsageCountedSessionIdFromFileName,
  resolveSessionHeaderUsageFamilyKey,
} from "../config/sessions/artifacts.js";
import {
  resolveSessionTranscriptsDirForAgent,
  resolveStorePath,
} from "../config/sessions/paths.js";
import type { AgentUsageBudgetConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.js";
import { acquireFileLock, type FileLockHandle } from "../infra/file-lock.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import {
  USAGE_BUDGET_RECORDED_COST_METADATA_KEY,
  USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION,
  hasUsageBudgetUnpriceableCostMetadata,
  type UsageBudgetCostMultiplierMetadata,
  type UsageBudgetRecordedCostMetadata,
} from "../shared/usage-budget-recorded-cost.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  estimateUsageCost,
  formatTokenCount,
  formatUsd,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "../utils/usage-format.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope-config.js";
/** Agent-scoped model-call usage budget admission checks. */
import {
  COMPACTION_USAGE_ACCOUNTING_CUSTOM_TYPE,
  MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE,
  USAGE_BUDGET_OPERATION_ID_KEY,
} from "./compaction-usage-accounting.js";
import { stableStringify } from "./stable-stringify.js";
import { hasNonzeroUsage, normalizeUsage, type NormalizedUsage, type UsageLike } from "./usage.js";

type BudgetWindowKind = "daily" | "monthly";
type BudgetLimitKind = "spend" | "tokens";

type UsageBudgetRecordedCostUsage = UsageLike & {
  cost?: { total: number };
  [USAGE_BUDGET_RECORDED_COST_METADATA_KEY]:
    | UsageBudgetRecordedCostMetadata
    | UsageBudgetCostMultiplierMetadata;
};

export const AGENT_USAGE_BUDGET_VISIBLE_DENIAL =
  "This agent's usage budget is currently blocking model calls. Ask an operator to review the budget before retrying.";

export type AgentUsageBudgetAdmissionReservation = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
};

function normalizeUsageBudgetCostMultiplier(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

export type AgentUsageBudgetErrorDetails = {
  agentId: string;
  provider: string;
  model: string;
  harnessId?: string;
  window?: BudgetWindowKind;
  limitKind?: BudgetLimitKind;
  used?: number;
  limit?: number;
  resetAt?: string;
  missingCostEntries?: number;
  missingUsageEntries?: number;
  reason:
    | "exceeded"
    | "missing_model_pricing"
    | "missing_window_cost"
    | "missing_window_usage"
    | "record_failed"
    | "scan_failed"
    | "unsupported_stream"
    | "unsupported_harness";
};

export class AgentUsageBudgetError extends Error {
  readonly code = "agent_usage_budget_blocked";
  readonly details: AgentUsageBudgetErrorDetails;

  constructor(message: string, details: AgentUsageBudgetErrorDetails) {
    super(message);
    this.name = "AgentUsageBudgetError";
    this.details = details;
  }
}

export function isAgentUsageBudgetError(error: unknown): error is AgentUsageBudgetError {
  return (
    error instanceof AgentUsageBudgetError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "agent_usage_budget_blocked")
  );
}

export function isAgentUsageBudgetErrorMessage(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("Usage budget blocked for agent ");
}

function hasBudgetLimits(config?: AgentUsageBudgetConfig): boolean {
  return (
    config?.daily?.usd !== undefined ||
    config?.daily?.tokens !== undefined ||
    config?.monthly?.usd !== undefined ||
    config?.monthly?.tokens !== undefined
  );
}

function resolveAgentUsageBudgetAgentId(params: {
  config?: OpenClawConfig;
  agentId?: string | null;
}): string {
  const implicitAgentId = params.config ? resolveDefaultAgentId(params.config) : DEFAULT_AGENT_ID;
  return normalizeAgentId(params.agentId ?? implicitAgentId);
}

export function resolveAgentUsageBudgetConfig(params: {
  config?: OpenClawConfig;
  agentId?: string | null;
}): AgentUsageBudgetConfig | undefined {
  const defaults = params.config?.agents?.defaults?.usageBudget;
  const agentId = resolveAgentUsageBudgetAgentId(params);
  const budget =
    params.config && agentId ? resolveAgentConfig(params.config, agentId)?.usageBudget : undefined;
  const resolved = budget ?? defaults;
  if (resolved?.enabled === false || !hasBudgetLimits(resolved)) {
    return undefined;
  }
  return resolved;
}

export function hasAnyActiveAgentUsageBudgetConfig(config?: OpenClawConfig): boolean {
  if (!config) {
    return false;
  }
  if (resolveAgentUsageBudgetConfig({ config })) {
    return true;
  }
  const agents = config.agents?.list;
  if (!Array.isArray(agents)) {
    return false;
  }
  return agents.some(
    (agent) =>
      typeof agent?.id === "string" &&
      Boolean(resolveAgentUsageBudgetConfig({ config, agentId: agent.id })),
  );
}

export function hasActiveAgentUsageBudgetForScope(params: {
  config?: OpenClawConfig;
  agentId?: string | null;
}): boolean {
  if (params.agentId === undefined || params.agentId === null) {
    return hasAnyActiveAgentUsageBudgetConfig(params.config);
  }
  return Boolean(resolveAgentUsageBudgetConfig(params));
}

type UsageBudgetWindow = {
  kind: BudgetWindowKind;
  label: string;
  startMs: number;
  resetAtMs: number;
};
type UsageBudgetCheck = {
  window: UsageBudgetWindow;
  limits: NonNullable<AgentUsageBudgetConfig["daily"]>;
};

export function resolveUsageBudgetWindow(kind: BudgetWindowKind, nowMs: number): UsageBudgetWindow {
  const now = new Date(nowMs);
  if (kind === "daily") {
    const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const resetAtMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return { kind, label: "daily", startMs, resetAtMs };
  }
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const resetAtMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { kind, label: "monthly", startMs, resetAtMs };
}

function isModelPricingKnown(
  cost: ReturnType<typeof resolveModelCostConfig>,
): cost is NonNullable<ReturnType<typeof resolveModelCostConfig>> {
  if (!cost) {
    return false;
  }
  if (cost.tieredPricing && cost.tieredPricing.length > 0) {
    return true;
  }
  return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
}

function isVerifiedZeroCostModelRoute(params: { provider?: string; model?: string }): boolean {
  const provider = params.provider?.trim().toLowerCase();
  const model = params.model?.trim().toLowerCase();
  if (!model) {
    return false;
  }
  return provider === "openrouter" && (model === "openrouter/free" || model.endsWith(":free"));
}

function isModelPricingKnownForRoute(
  cost: ReturnType<typeof resolveModelCostConfig>,
  route: { provider?: string; model?: string },
): cost is NonNullable<ReturnType<typeof resolveModelCostConfig>> {
  return isModelPricingKnown(cost) || Boolean(cost && isVerifiedZeroCostModelRoute(route));
}

function spendBudgetActive(config: AgentUsageBudgetConfig): boolean {
  return config.daily?.usd !== undefined || config.monthly?.usd !== undefined;
}

function formatResetAt(ms: number): string {
  return new Date(ms).toISOString();
}

function formatBudgetUsed(kind: BudgetLimitKind, value: number): string {
  return kind === "spend" ? (formatUsd(value) ?? "$0.00") : `${formatTokenCount(value)} tokens`;
}

function formatBudgetLimit(kind: BudgetLimitKind, value: number): string {
  return kind === "spend" ? (formatUsd(value) ?? `$${value}`) : `${formatTokenCount(value)} tokens`;
}

function buildExceededError(params: {
  agentId: string;
  provider: string;
  model: string;
  window: UsageBudgetWindow;
  limitKind: BudgetLimitKind;
  used: number;
  limit: number;
}): AgentUsageBudgetError {
  const resetAt = formatResetAt(params.window.resetAtMs);
  return new AgentUsageBudgetError(
    `Usage budget blocked for agent "${params.agentId}": ${params.window.label} ${
      params.limitKind === "spend" ? "spend" : "token"
    } budget is exhausted (${formatBudgetUsed(params.limitKind, params.used)}/${formatBudgetLimit(
      params.limitKind,
      params.limit,
    )}, resets ${resetAt}).`,
    {
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
      window: params.window.kind,
      limitKind: params.limitKind,
      used: params.used,
      limit: params.limit,
      resetAt,
      reason: "exceeded",
    },
  );
}

function buildMissingModelPricingError(params: {
  agentId: string;
  provider: string;
  model: string;
}): AgentUsageBudgetError {
  return new AgentUsageBudgetError(
    `Usage budget blocked for agent "${params.agentId}": spend budget is active but pricing is missing for ${params.provider}/${params.model}. Configure model pricing or use a token budget.`,
    {
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
      reason: "missing_model_pricing",
    },
  );
}

function buildMissingWindowCostError(params: {
  agentId: string;
  provider: string;
  model: string;
  window: UsageBudgetWindow;
  missingCostEntries: number;
}): AgentUsageBudgetError {
  const resetAt = formatResetAt(params.window.resetAtMs);
  return new AgentUsageBudgetError(
    `Usage budget blocked for agent "${params.agentId}": ${params.window.label} spend budget has ${params.missingCostEntries} prior model call(s) without usable cost data (resets ${resetAt}). Configure pricing or use token budgets.`,
    {
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
      window: params.window.kind,
      limitKind: "spend",
      resetAt,
      missingCostEntries: params.missingCostEntries,
      reason: "missing_window_cost",
    },
  );
}

function buildMissingWindowUsageError(params: {
  agentId: string;
  provider: string;
  model: string;
  window: UsageBudgetWindow;
  limitKind: BudgetLimitKind;
  missingUsageEntries: number;
}): AgentUsageBudgetError {
  const resetAt = formatResetAt(params.window.resetAtMs);
  return new AgentUsageBudgetError(
    `Usage budget blocked for agent "${params.agentId}": ${params.window.label} ${
      params.limitKind === "spend" ? "spend" : "token"
    } budget has ${params.missingUsageEntries} prior model call(s) without usable usage data (resets ${resetAt}). Wait for provider usage data or use a window after reset.`,
    {
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
      window: params.window.kind,
      limitKind: params.limitKind,
      resetAt,
      missingUsageEntries: params.missingUsageEntries,
      reason: "missing_window_usage",
    },
  );
}

function buildUsageBudgetScanFailedError(params: {
  agentId: string;
  provider: string;
  model: string;
  cause: unknown;
}): AgentUsageBudgetError {
  void params.cause;
  return new AgentUsageBudgetError(
    `Usage budget blocked for agent "${params.agentId}": could not read prior model-call usage. Retry after transcript storage is readable.`,
    {
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
      reason: "scan_failed",
    },
  );
}

function buildUsageBudgetRecordFailedError(params: {
  agentId: string;
  provider: string;
  model: string;
  cause: unknown;
}): AgentUsageBudgetError {
  void params.cause;
  return new AgentUsageBudgetError(
    `Usage budget blocked for agent "${params.agentId}": could not persist model-call usage. Retry after usage-budget storage is writable.`,
    {
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
      reason: "record_failed",
    },
  );
}

export function buildUnsupportedAgentUsageBudgetHarnessError(params: {
  agentId: string | null | undefined;
  provider: string;
  model: string;
  harnessId: string;
}): AgentUsageBudgetError {
  const agentId = normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID);
  return new AgentUsageBudgetError(
    `Usage budget blocked for agent "${agentId}": agent harness "${params.harnessId}" does not expose per-call usage-budget enforcement. Select the OpenClaw harness or disable the budget for this agent.`,
    {
      agentId,
      provider: params.provider,
      model: params.model,
      harnessId: params.harnessId,
      reason: "unsupported_harness",
    },
  );
}

export function buildUnsupportedAgentUsageBudgetStreamError(params: {
  agentId: string | null | undefined;
  provider: string;
  model: string;
}): AgentUsageBudgetError {
  const agentId = normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID);
  return new AgentUsageBudgetError(
    `Usage budget blocked for agent "${agentId}": model stream does not expose provider-dispatch usage-budget accounting. Use a provider transport that reports dispatch or disable the budget for this agent.`,
    {
      agentId,
      provider: params.provider,
      model: params.model,
      reason: "unsupported_stream",
    },
  );
}

export function assertNoActiveAgentUsageBudgetForUnsupportedHarness(params: {
  config?: OpenClawConfig;
  agentId?: string | null;
  provider: string;
  model: string;
  harnessId: string;
}): void {
  if (!hasActiveAgentUsageBudgetForScope({ config: params.config, agentId: params.agentId })) {
    return;
  }
  throw buildUnsupportedAgentUsageBudgetHarnessError({
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    harnessId: params.harnessId,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function resolveUsageBudgetAccountingMessage(
  entry: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    entry.type !== "custom" ||
    (entry.customType !== COMPACTION_USAGE_ACCOUNTING_CUSTOM_TYPE &&
      entry.customType !== MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE)
  ) {
    return undefined;
  }
  const data = isRecord(entry.data) ? entry.data : undefined;
  return isRecord(data?.message) ? data.message : undefined;
}

function isUsageBudgetModelCallBridgeEntry(entry: Record<string, unknown>): boolean {
  if (entry.type !== "custom" || entry.customType !== MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE) {
    return false;
  }
  const data = isRecord(entry.data) ? entry.data : undefined;
  return data?.usageBudgetBridge === true;
}

function resolveUsageBudgetOperationId(entry: Record<string, unknown>): string | undefined {
  const message = isRecord(entry.message) ? entry.message : undefined;
  const messageId = message?.[USAGE_BUDGET_OPERATION_ID_KEY];
  if (typeof messageId === "string" && messageId.trim().length > 0) {
    return messageId;
  }
  if (
    (entry.type === "compaction" || entry.type === "branch_summary") &&
    isRecord(entry.usageAccounting)
  ) {
    const operationId = entry.usageAccounting[USAGE_BUDGET_OPERATION_ID_KEY];
    return typeof operationId === "string" && operationId.trim().length > 0
      ? operationId
      : undefined;
  }
  if (
    entry.type === "custom" &&
    (entry.customType === COMPACTION_USAGE_ACCOUNTING_CUSTOM_TYPE ||
      entry.customType === MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE)
  ) {
    const data = isRecord(entry.data) ? entry.data : undefined;
    const operationId = data?.[USAGE_BUDGET_OPERATION_ID_KEY];
    return typeof operationId === "string" && operationId.trim().length > 0
      ? operationId
      : undefined;
  }
  return undefined;
}

function resolveBudgetTranscriptMessage(
  entry: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (isRecord(entry.message)) {
    return entry.message;
  }
  if (
    (entry.type === "compaction" || entry.type === "branch_summary") &&
    isRecord(entry.usageAccounting)
  ) {
    const accounting = entry.usageAccounting;
    return {
      role: "assistant",
      content: [],
      api: accounting.api,
      provider: accounting.provider,
      model: accounting.model,
      usage: accounting.usage,
      stopReason: "stop",
      timestamp: entry.timestamp,
    };
  }
  return resolveUsageBudgetAccountingMessage(entry);
}

function readUsageBudgetRecordId(entry: Record<string, unknown>): string | undefined {
  return typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined;
}

function buildUsageBudgetRecordDedupKey(
  entry: Record<string, unknown>,
  params?: { sessionId?: string },
): string | undefined {
  const entryId = readUsageBudgetRecordId(entry);
  if (!entryId) {
    return undefined;
  }
  return ["transcript-entry", params?.sessionId ?? "", entryId].join("|");
}

function parseUsageBudgetRecordDedupKey(
  dedupKey: string | undefined,
): { entryId: string; sessionId: string } | undefined {
  const prefix = "transcript-entry|";
  if (!dedupKey?.startsWith(prefix)) {
    return undefined;
  }
  const rest = dedupKey.slice(prefix.length);
  const separatorIndex = rest.indexOf("|");
  if (separatorIndex === -1) {
    return undefined;
  }
  return {
    sessionId: rest.slice(0, separatorIndex),
    entryId: rest.slice(separatorIndex + 1),
  };
}

function buildAgentScopedUsageBudgetLedgerKey(agentId: string, dedupKey: string): string {
  return JSON.stringify([agentId, dedupKey]);
}

function readAgentScopedUsageBudgetLedgerKey(value: string, agentId: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed[0] === agentId &&
      typeof parsed[1] === "string"
    ) {
      return parsed[1];
    }
  } catch {
    // Older or hand-authored rows may not use the JSON tuple key.
  }
  return value;
}

function parseTranscriptTimestampMs(entry: Record<string, unknown>): number | undefined {
  const message = resolveBudgetTranscriptMessage(entry);
  const raw = entry.timestamp ?? message?.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function hasExplicitProviderAccountedZeroUsage(usage: NormalizedUsage, usageRaw: unknown): boolean {
  return usageTokenTotal(usage) === 0 && readUsageBudgetRecordedCostTotal(usageRaw) !== undefined;
}

export function readUsageBudgetRecordedCostMetadata(usageRaw: unknown):
  | {
      total?: number;
      kind: UsageBudgetRecordedCostMetadata["kind"] | UsageBudgetCostMultiplierMetadata["kind"];
      costMultiplier: number;
      authoritativeCost: boolean;
    }
  | undefined {
  if (!isRecord(usageRaw)) {
    return undefined;
  }
  const metadata = usageRaw[USAGE_BUDGET_RECORDED_COST_METADATA_KEY];
  if (!isRecord(metadata)) {
    return undefined;
  }
  if (
    metadata.schemaVersion !== USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION ||
    (metadata.kind !== "estimated-model-call-cost" &&
      metadata.kind !== "provider-billed-model-call-cost" &&
      metadata.kind !== "model-call-cost-multiplier")
  ) {
    return undefined;
  }
  const costMultiplier = metadata.costMultiplier;
  if (
    typeof costMultiplier !== "number" ||
    !Number.isFinite(costMultiplier) ||
    costMultiplier <= 0
  ) {
    return undefined;
  }
  const total = isRecord(usageRaw.cost) ? usageRaw.cost.total : undefined;
  const trustedTotal =
    typeof total === "number" &&
    Number.isFinite(total) &&
    (metadata.kind === "provider-billed-model-call-cost" ? total >= 0 : total > 0)
      ? total
      : undefined;
  return {
    ...(trustedTotal !== undefined ? { total: trustedTotal } : {}),
    kind: metadata.kind,
    costMultiplier,
    authoritativeCost: metadata.kind !== "model-call-cost-multiplier",
  };
}

export function readUsageBudgetRecordedCostTotal(usageRaw: unknown): number | undefined {
  const metadata = readUsageBudgetRecordedCostMetadata(usageRaw);
  return metadata?.authoritativeCost === true ? metadata.total : undefined;
}

type PendingUsageBudgetEntry = {
  provider: string;
  model: string;
  timestampMs: number;
  usage?: ReturnType<typeof normalizeUsage>;
};

const PENDING_USAGE_BUDGET_ENTRY_TTL_MS = 5 * 60 * 1000;
const pendingUsageBudgetEntriesByAgent = new Map<string, PendingUsageBudgetEntry[]>();
type UsageBudgetRecordFailureSentinel = {
  resetAtMs: number;
};
const recordFailureSentinelsByAgent = new Map<string, UsageBudgetRecordFailureSentinel>();
const PENDING_USAGE_PERSISTENCE_MATCH_WINDOW_MS = PENDING_USAGE_BUDGET_ENTRY_TTL_MS;
const USAGE_BUDGET_LEDGER_BRIDGE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const USAGE_BUDGET_IN_FLIGHT_RECORD_ID_PREFIX = "usage-budget-inflight:";
const USAGE_BUDGET_ADMISSION_LOCK_OPTIONS = {
  retries: {
    retries: 18_000,
    factor: 1,
    minTimeout: 100,
    maxTimeout: 100,
    randomize: true,
  },
  stale: 30 * 60 * 1000,
} as const;

export type AgentUsageBudgetAccountedEntry = {
  dedupKey?: string;
  recordId?: string;
  sourceFilePath?: string;
  sourceLineIndex?: number;
  source: "message" | "compaction" | "branch_summary" | "compaction_custom" | "model_call_custom";
  provider?: string;
  model?: string;
  timestampMs: number;
  usage?: NormalizedUsage;
  usageRaw?: UsageLike;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  totalTokens: number;
  totalCost: number;
  missingCostEntries: number;
  missingTokenUsageEntries: number;
  missingSpendEvidenceEntries: number;
  usageBudgetOperationId?: string;
};

type UsageBudgetWindowTotals = {
  totalTokens: number;
  totalCost: number;
  missingCostEntries: number;
  missingTokenUsageEntries: number;
  missingSpendEvidenceEntries: number;
};

type AgentUsageBudgetLedgerDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "agent_usage_budget_ledger" | "agent_usage_budget_transcript_import_state"
>;

type AgentUsageBudgetLedgerRow = {
  agent_id: string;
  dedup_key: string;
  model: string;
  provider: string;
  record_id: string;
  timestamp_ms: number;
  usage_accounting_source: string;
  usage_budget_bridge: number;
  usage_budget_operation_id: string | null;
  usage_json: string | null;
};

type AgentUsageBudgetTranscriptImportStateRow = {
  active_transcript_mtime_ms: number | null;
  active_transcript_path: string | null;
  active_transcript_size: number | null;
  agent_id: string;
  imported_min_start_ms: number;
  sessions_dir_exists: number;
  sessions_dirs_fingerprint: string | null;
  sessions_dir_mtime_ms: number | null;
  updated_at_ms: number;
};

type UsageBudgetSessionsDirState = {
  activeFile?: {
    mtimeMs: number;
    path: string;
    size: number;
  };
  dirs: Array<{
    exists: boolean;
    mtimeMs: number | null;
    path: string;
  }>;
  files: Array<{
    exists: boolean;
    mtimeMs: number | null;
    path: string;
    size: number | null;
  }>;
  dirsFingerprint: string;
  exists: boolean;
  mtimeMs: number | null;
};

type UsageBudgetSessionsFingerprint = {
  dirs: UsageBudgetSessionsDirState["dirs"];
  files: UsageBudgetSessionsDirState["files"];
};

function normalizeUsageAccountingSource(
  value: string | null | undefined,
): AgentUsageBudgetAccountedEntry["source"] {
  return value === "compaction" ||
    value === "branch_summary" ||
    value === "compaction_custom" ||
    value === "model_call_custom"
    ? value
    : "message";
}

function resolveUsageBudgetAccountedEntrySource(
  entry: Record<string, unknown>,
): AgentUsageBudgetAccountedEntry["source"] {
  if (entry.type === "compaction") {
    return "compaction";
  }
  if (entry.type === "branch_summary") {
    return "branch_summary";
  }
  if (isUsageBudgetModelCallBridgeEntry(entry)) {
    return "model_call_custom";
  }
  if (entry.type === "custom" && entry.customType === COMPACTION_USAGE_ACCOUNTING_CUSTOM_TYPE) {
    return "compaction_custom";
  }
  return "message";
}

type UsageBudgetTranscriptFileCacheEntry = {
  size: number;
  mtimeMs: number;
  fileIdentityKey?: string;
  tailFingerprint?: string;
  pricingFingerprint: string;
  usageIdentitySessionId: string;
  legacyRowOccurrences: Map<string, number>;
  entries: AgentUsageBudgetAccountedEntry[];
};

const usageBudgetTranscriptFileCacheByAgent = new Map<
  string,
  Map<string, UsageBudgetTranscriptFileCacheEntry>
>();
const USAGE_BUDGET_TRANSCRIPT_CONTINUITY_BYTES = 4096;

function createEmptyUsageBudgetWindowTotals(): UsageBudgetWindowTotals {
  return {
    totalTokens: 0,
    totalCost: 0,
    missingCostEntries: 0,
    missingTokenUsageEntries: 0,
    missingSpendEvidenceEntries: 0,
  };
}

function usageBudgetComponentTokenTotal(usage: NormalizedUsage): number {
  return (
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  );
}

function usageTokenTotal(usage: NormalizedUsage): number {
  return Math.max(usage.total ?? 0, usageBudgetComponentTokenTotal(usage));
}

function normalizeUsageBudgetReservation(
  reservation?: AgentUsageBudgetAdmissionReservation,
): NormalizedUsage | undefined {
  if (!reservation) {
    return undefined;
  }
  const coerceCount = (value: number | undefined): number | undefined =>
    value !== undefined && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
  const input = coerceCount(reservation.input ?? reservation.inputTokens);
  const output = coerceCount(reservation.output ?? reservation.outputTokens);
  const cacheRead = coerceCount(reservation.cacheRead ?? reservation.cacheReadTokens);
  const cacheWrite = coerceCount(reservation.cacheWrite ?? reservation.cacheWriteTokens);
  const total = coerceCount(reservation.total ?? reservation.totalTokens);
  const normalized = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(total !== undefined ? { total } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function usageBudgetReservationTokenTotal(reservation: NormalizedUsage | undefined): number {
  if (!reservation) {
    return 0;
  }
  const componentTotal =
    (reservation.input ?? 0) +
    (reservation.output ?? 0) +
    (reservation.cacheRead ?? 0) +
    (reservation.cacheWrite ?? 0);
  return Math.max(reservation.total ?? 0, componentTotal);
}

type UsageBudgetCostComponent = "input" | "output" | "cacheRead" | "cacheWrite";

function usageBudgetMaxComponentCostRate(
  cost: NonNullable<ReturnType<typeof resolveModelCostConfig>>,
  components: readonly UsageBudgetCostComponent[],
): number {
  const rates = [cost, ...(cost.tieredPricing ?? [])].flatMap((pricing) =>
    components.map((component) => pricing[component]),
  );
  return Math.max(...rates.filter((rate) => Number.isFinite(rate) && rate >= 0), 0);
}

function usageBudgetMaxCostRate(cost: NonNullable<ReturnType<typeof resolveModelCostConfig>>) {
  return usageBudgetMaxComponentCostRate(cost, ["input", "output", "cacheRead", "cacheWrite"]);
}

function usageBudgetReservationCostTotal(params: {
  reservation: NormalizedUsage | undefined;
  cost: NonNullable<ReturnType<typeof resolveModelCostConfig>>;
}): number {
  const reservationTokens = usageBudgetReservationTokenTotal(params.reservation);
  if (!params.reservation || reservationTokens <= 0) {
    return 0;
  }
  // Prompt reservations precede provider cache classification. Price them at
  // the worst prompt lane so cache writes cannot cross a hard spend ceiling.
  const componentCost =
    ((params.reservation.input ?? 0) *
      usageBudgetMaxComponentCostRate(params.cost, ["input", "cacheRead", "cacheWrite"]) +
      (params.reservation.output ?? 0) * usageBudgetMaxComponentCostRate(params.cost, ["output"]) +
      (params.reservation.cacheRead ?? 0) *
        usageBudgetMaxComponentCostRate(params.cost, ["cacheRead"]) +
      (params.reservation.cacheWrite ?? 0) *
        usageBudgetMaxComponentCostRate(params.cost, ["cacheWrite"])) /
    1_000_000;
  const componentTokens = usageBudgetComponentTokenTotal(params.reservation);
  const unassignedTokens = Math.max(0, (params.reservation.total ?? 0) - componentTokens);
  return componentCost + (unassignedTokens * usageBudgetMaxCostRate(params.cost)) / 1_000_000;
}

function estimateUsageBudgetCostTotal(params: {
  usage: NormalizedUsage;
  cost: NonNullable<ReturnType<typeof resolveModelCostConfig>>;
}): number | undefined {
  const componentCost = estimateUsageCost({ usage: params.usage, cost: params.cost });
  if (componentCost === undefined) {
    return undefined;
  }
  const unassignedTokens = Math.max(
    0,
    usageTokenTotal(params.usage) - usageBudgetComponentTokenTotal(params.usage),
  );
  return componentCost + (unassignedTokens * usageBudgetMaxCostRate(params.cost)) / 1_000_000;
}

function resolveUsageBudgetAccountedCostTotal(params: {
  usage: NormalizedUsage;
  usageRaw: unknown;
  config?: OpenClawConfig;
  provider?: string;
  model?: string;
}): number | undefined {
  const metadata = readUsageBudgetRecordedCostMetadata(params.usageRaw);
  if (!metadata) {
    // Legacy local totals do not prove the provider dispatch tier. A standard
    // estimate could otherwise undercount a priority/capacity-billed call.
    return undefined;
  }
  if (metadata.authoritativeCost && metadata.total !== undefined) {
    return metadata.total;
  }
  if (metadata.kind === "provider-billed-model-call-cost") {
    return undefined;
  }
  const cost = resolveModelCostConfig({
    provider: params.provider,
    model: params.model,
    config: params.config,
  });
  if (!isModelPricingKnownForRoute(cost, { provider: params.provider, model: params.model })) {
    return undefined;
  }
  const estimatedCost = estimateUsageBudgetCostTotal({ usage: params.usage, cost });
  return estimatedCost === undefined ? undefined : estimatedCost * metadata.costMultiplier;
}

export function resolveUsageBudgetCostMultiplierUsage(params: {
  config?: OpenClawConfig;
  provider: string;
  model: string;
  usage?: UsageLike;
  costMultiplier?: number;
}): UsageLike | undefined {
  if (!params.usage) {
    return undefined;
  }
  const multiplier = normalizeUsageBudgetCostMultiplier(params.costMultiplier);
  const recordedCostMetadata = readUsageBudgetRecordedCostMetadata(params.usage);
  if (recordedCostMetadata !== undefined || hasUsageBudgetUnpriceableCostMetadata(params.usage)) {
    return params.usage;
  }
  const usage = normalizeUsage(params.usage);
  if (!usage || usageTokenTotal(usage) <= 0) {
    return params.usage;
  }
  const cost = resolveModelCostConfig({
    provider: params.provider,
    model: params.model,
    config: params.config,
  });
  const estimatedCost = isModelPricingKnownForRoute(cost, {
    provider: params.provider,
    model: params.model,
  })
    ? estimateUsageBudgetCostTotal({ usage, cost })
    : undefined;
  const usageWithRecordedCost: UsageBudgetRecordedCostUsage = {
    ...usage,
    ...(estimatedCost !== undefined ? { cost: { total: estimatedCost * multiplier } } : {}),
    [USAGE_BUDGET_RECORDED_COST_METADATA_KEY]: {
      schemaVersion: USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION,
      kind:
        estimatedCost === undefined ? "model-call-cost-multiplier" : "estimated-model-call-cost",
      costMultiplier: multiplier,
    },
  };
  return usageWithRecordedCost;
}

function pendingUsageCostTotal(params: {
  entry: PendingUsageBudgetEntry;
  config?: OpenClawConfig;
}): number | undefined {
  const usage = params.entry.usage;
  if (!usage || usageTokenTotal(usage) <= 0) {
    return undefined;
  }
  const cost = resolveModelCostConfig({
    provider: params.entry.provider,
    model: params.entry.model,
    config: params.config,
  });
  if (
    isModelPricingKnownForRoute(cost, {
      provider: params.entry.provider,
      model: params.entry.model,
    })
  ) {
    return estimateUsageBudgetCostTotal({ usage, cost });
  }
  return undefined;
}

function usageBudgetPricingFingerprint(config?: OpenClawConfig): string {
  return resolveModelCostConfigFingerprint(config);
}

function usageBudgetEntrySignature(params: {
  provider?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  missingTokenUsageEntries?: number;
}): string {
  return [
    params.provider ?? "",
    params.model ?? "",
    params.missingTokenUsageEntries && params.missingTokenUsageEntries > 0 ? "missing" : "usage",
    params.input ?? "",
    params.output ?? "",
    params.cacheRead ?? "",
    params.cacheWrite ?? "",
    params.total ?? "",
  ].join("|");
}

function pendingUsageBudgetEntrySignature(entry: PendingUsageBudgetEntry): string {
  return usageBudgetEntrySignature({
    provider: entry.provider,
    model: entry.model,
    input: entry.usage?.input,
    output: entry.usage?.output,
    cacheRead: entry.usage?.cacheRead,
    cacheWrite: entry.usage?.cacheWrite,
    total: entry.usage?.total,
    missingTokenUsageEntries: entry.usage && usageTokenTotal(entry.usage) > 0 ? 0 : 1,
  });
}

function rememberUsageBudgetRecordFailure(params: {
  config?: OpenClawConfig;
  agentId: string;
  timestampMs: number;
}): void {
  const budget = resolveAgentUsageBudgetConfig({
    config: params.config,
    agentId: params.agentId,
  });
  if (!budget) {
    return;
  }
  const resetAtCandidates = [
    budget.daily?.usd !== undefined || budget.daily?.tokens !== undefined
      ? resolveUsageBudgetWindow("daily", params.timestampMs).resetAtMs
      : undefined,
    budget.monthly?.usd !== undefined || budget.monthly?.tokens !== undefined
      ? resolveUsageBudgetWindow("monthly", params.timestampMs).resetAtMs
      : undefined,
  ].filter((value): value is number => value !== undefined);
  if (resetAtCandidates.length === 0) {
    return;
  }
  const resetAtMs = Math.max(...resetAtCandidates);
  const current = recordFailureSentinelsByAgent.get(params.agentId);
  recordFailureSentinelsByAgent.set(params.agentId, {
    resetAtMs: Math.max(current?.resetAtMs ?? 0, resetAtMs),
  });
}

function hasActiveUsageBudgetRecordFailure(agentId: string, nowMs: number): boolean {
  const sentinel = recordFailureSentinelsByAgent.get(agentId);
  if (!sentinel) {
    return false;
  }
  if (sentinel.resetAtMs <= nowMs) {
    recordFailureSentinelsByAgent.delete(agentId);
    return false;
  }
  return true;
}

function usageBudgetTimestampsNear(leftMs: number, rightMs: number): boolean {
  return Math.abs(leftMs - rightMs) <= PENDING_USAGE_PERSISTENCE_MATCH_WINDOW_MS;
}

function usageBudgetEntryMatchesPending(
  persisted: AgentUsageBudgetAccountedEntry,
  pending: PendingUsageBudgetEntry,
): boolean {
  return (
    usageBudgetTimestampsNear(persisted.timestampMs, pending.timestampMs) &&
    usageBudgetEntrySignature(persisted) === pendingUsageBudgetEntrySignature(pending)
  );
}

function usageBudgetAccountedEntryMatchesPendingAggregate(
  persisted: AgentUsageBudgetAccountedEntry,
  pendingEntries: readonly PendingUsageBudgetEntry[],
): boolean {
  if (pendingEntries.length < 2 || persisted.totalTokens <= 0) {
    return false;
  }
  if (
    !pendingEntries.every((entry) => {
      return (
        entry.provider === persisted.provider &&
        entry.model === persisted.model &&
        usageBudgetTimestampsNear(entry.timestampMs, persisted.timestampMs) &&
        entry.usage &&
        usageTokenTotal(entry.usage) > 0
      );
    })
  ) {
    return false;
  }
  const totals = pendingEntries.reduce(
    (sum, entry) => {
      const usage = entry.usage!;
      sum.input += usage.input ?? 0;
      sum.output += usage.output ?? 0;
      sum.cacheRead += usage.cacheRead ?? 0;
      sum.cacheWrite += usage.cacheWrite ?? 0;
      sum.total += usageTokenTotal(usage);
      return sum;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );
  return (
    totals.input === (persisted.input ?? 0) &&
    totals.output === (persisted.output ?? 0) &&
    totals.cacheRead === (persisted.cacheRead ?? 0) &&
    totals.cacheWrite === (persisted.cacheWrite ?? 0) &&
    totals.total === persisted.totalTokens
  );
}

function prunePendingUsageBudgetEntries(
  agentId: string,
  nowMs: number,
  persistedEntries?: readonly AgentUsageBudgetAccountedEntry[],
): PendingUsageBudgetEntry[] {
  const entries = pendingUsageBudgetEntriesByAgent.get(agentId) ?? [];
  let kept = entries.filter(
    (entry) => nowMs - entry.timestampMs <= PENDING_USAGE_BUDGET_ENTRY_TTL_MS,
  );
  if (persistedEntries?.length) {
    const consumedPersisted = new Set<number>();
    kept = kept.filter((pending) => {
      const persistedIndex = persistedEntries.findIndex((persisted, index) => {
        return !consumedPersisted.has(index) && usageBudgetEntryMatchesPending(persisted, pending);
      });
      if (persistedIndex === -1) {
        return true;
      }
      consumedPersisted.add(persistedIndex);
      return false;
    });

    const consumedPending = new Set<number>();
    for (const [persistedIndex, persisted] of persistedEntries.entries()) {
      if (consumedPersisted.has(persistedIndex)) {
        continue;
      }
      const candidateIndexes = kept
        .map((pending, index) => ({ pending, index }))
        .filter(({ pending, index }) => {
          return (
            !consumedPending.has(index) &&
            pending.provider === persisted.provider &&
            pending.model === persisted.model &&
            usageBudgetTimestampsNear(pending.timestampMs, persisted.timestampMs)
          );
        });
      if (
        usageBudgetAccountedEntryMatchesPendingAggregate(
          persisted,
          candidateIndexes.map(({ pending }) => pending),
        )
      ) {
        for (const { index } of candidateIndexes) {
          consumedPending.add(index);
        }
      }
    }
    kept = kept.filter((_pending, index) => !consumedPending.has(index));
  }
  if (kept.length > 0) {
    pendingUsageBudgetEntriesByAgent.set(agentId, kept);
  } else {
    pendingUsageBudgetEntriesByAgent.delete(agentId);
  }
  return kept;
}

function summarizePendingUsageBudgetEntries(params: {
  agentId: string;
  window: UsageBudgetWindow;
  endMs: number;
  config?: OpenClawConfig;
  persistedEntries?: readonly AgentUsageBudgetAccountedEntry[];
}): UsageBudgetWindowTotals {
  const summary = createEmptyUsageBudgetWindowTotals();
  for (const entry of prunePendingUsageBudgetEntries(
    params.agentId,
    params.endMs,
    params.persistedEntries,
  )) {
    if (entry.timestampMs < params.window.startMs || entry.timestampMs > params.endMs) {
      continue;
    }
    const usage = entry.usage;
    if (!usage || usageTokenTotal(usage) <= 0) {
      summary.missingTokenUsageEntries += 1;
      summary.missingSpendEvidenceEntries += 1;
      continue;
    }
    summary.totalTokens += usageTokenTotal(usage);
    const cost = pendingUsageCostTotal({ entry, config: params.config });
    if (cost === undefined) {
      summary.missingCostEntries += 1;
      summary.missingSpendEvidenceEntries += 1;
    } else {
      summary.totalCost += cost;
    }
  }
  return summary;
}

function usageBudgetAccountedEntrySignature(entry: AgentUsageBudgetAccountedEntry): string {
  return usageBudgetEntrySignature({
    provider: entry.provider,
    model: entry.model,
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead,
    cacheWrite: entry.cacheWrite,
    total: entry.total,
    missingTokenUsageEntries: entry.missingTokenUsageEntries,
  });
}

type UsageBudgetEntryComponents = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

function usageBudgetAccountedEntryComponents(
  entry: AgentUsageBudgetAccountedEntry,
): UsageBudgetEntryComponents {
  const input = entry.input ?? 0;
  const output = entry.output ?? 0;
  const cacheRead = entry.cacheRead ?? 0;
  const cacheWrite = entry.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: entry.total ?? entry.totalTokens ?? input + output + cacheRead + cacheWrite,
  };
}

function addUsageBudgetEntryComponents(
  left: UsageBudgetEntryComponents,
  right: UsageBudgetEntryComponents,
): UsageBudgetEntryComponents {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    total: left.total + right.total,
  };
}

function usageBudgetEntryComponentsEqual(
  left: UsageBudgetEntryComponents,
  right: UsageBudgetEntryComponents,
): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.total === right.total
  );
}

function usageBudgetEntryComponentsExceed(
  left: UsageBudgetEntryComponents,
  right: UsageBudgetEntryComponents,
): boolean {
  return (
    left.input > right.input ||
    left.output > right.output ||
    left.cacheRead > right.cacheRead ||
    left.cacheWrite > right.cacheWrite ||
    left.total > right.total
  );
}

function isAggregateUsageBudgetBridgeOwner(entry: AgentUsageBudgetAccountedEntry): boolean {
  return (
    entry.source === "compaction" ||
    entry.source === "branch_summary" ||
    entry.source === "compaction_custom"
  );
}

function usageBudgetKnownCostTotal(entry: AgentUsageBudgetAccountedEntry): number | undefined {
  if (entry.missingCostEntries > 0 || entry.missingSpendEvidenceEntries > 0) {
    return undefined;
  }
  return Number.isFinite(entry.totalCost) ? entry.totalCost : undefined;
}

function applyUsageBudgetBridgeReconciledCost(
  entry: AgentUsageBudgetAccountedEntry,
  totalCost: number,
): void {
  entry.totalCost = totalCost;
  entry.missingCostEntries = 0;
  entry.missingSpendEvidenceEntries = 0;
}

function applyUsageBudgetBridgeMissingCost(
  entry: AgentUsageBudgetAccountedEntry,
  missingEntries: number,
): void {
  entry.totalCost = 0;
  entry.missingCostEntries = Math.max(entry.missingCostEntries, missingEntries);
  entry.missingSpendEvidenceEntries = Math.max(entry.missingSpendEvidenceEntries, missingEntries);
}

function reconcileAggregateUsageBudgetBridgeOwnerCost(
  owner: AgentUsageBudgetAccountedEntry,
  bridges: readonly AgentUsageBudgetAccountedEntry[],
): void {
  if (!isAggregateUsageBudgetBridgeOwner(owner)) {
    return;
  }
  const target = usageBudgetAccountedEntryComponents(owner);
  let covered: UsageBudgetEntryComponents = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  let totalCost = 0;
  let missingCostEntries = 0;
  for (const bridge of bridges) {
    covered = addUsageBudgetEntryComponents(covered, usageBudgetAccountedEntryComponents(bridge));
    const bridgeCost = usageBudgetKnownCostTotal(bridge);
    if (bridgeCost === undefined) {
      missingCostEntries += 1;
      continue;
    }
    totalCost += bridgeCost;
  }
  if (!usageBudgetEntryComponentsEqual(covered, target)) {
    return;
  }
  if (missingCostEntries > 0) {
    applyUsageBudgetBridgeMissingCost(owner, missingCostEntries);
    return;
  }
  applyUsageBudgetBridgeReconciledCost(owner, totalCost);
}

function usageBudgetBridgeCanBelongToOwner(
  bridge: AgentUsageBudgetAccountedEntry,
  owner: AgentUsageBudgetAccountedEntry,
): boolean {
  const sameOperationId =
    bridge.usageBudgetOperationId !== undefined &&
    bridge.usageBudgetOperationId === owner.usageBudgetOperationId;
  if (
    owner.source === "compaction" ||
    owner.source === "branch_summary" ||
    owner.source === "compaction_custom"
  ) {
    return (
      bridge.source === "model_call_custom" &&
      bridge.missingTokenUsageEntries === 0 &&
      owner.missingTokenUsageEntries === 0 &&
      sameOperationId
    );
  }
  if (bridge.usageBudgetOperationId || owner.usageBudgetOperationId) {
    return (
      bridge.source === "model_call_custom" &&
      owner.source !== "model_call_custom" &&
      bridge.provider === owner.provider &&
      bridge.model === owner.model &&
      bridge.missingTokenUsageEntries === 0 &&
      owner.missingTokenUsageEntries === 0 &&
      sameOperationId
    );
  }
  return (
    bridge.source === "model_call_custom" &&
    owner.source !== "model_call_custom" &&
    bridge.provider === owner.provider &&
    bridge.model === owner.model &&
    bridge.missingTokenUsageEntries === 0 &&
    owner.missingTokenUsageEntries === 0 &&
    usageBudgetTimestampsNear(bridge.timestampMs, owner.timestampMs)
  );
}

function modelCallCustomEntryMatchesCanonicalOwner(
  bridge: AgentUsageBudgetAccountedEntry,
  owner: AgentUsageBudgetAccountedEntry,
): boolean {
  return (
    usageBudgetBridgeCanBelongToOwner(bridge, owner) &&
    usageBudgetAccountedEntrySignature(bridge) === usageBudgetAccountedEntrySignature(owner)
  );
}

function findUsageBudgetBridgeSubsetForOwner(params: {
  entry: AgentUsageBudgetAccountedEntry;
  entryIndex: number;
  owner: AgentUsageBudgetAccountedEntry;
  entries: readonly AgentUsageBudgetAccountedEntry[];
  consumedBridgeIndexes: Set<number>;
}): number[] | undefined {
  if (!usageBudgetBridgeCanBelongToOwner(params.entry, params.owner)) {
    return undefined;
  }
  const target = usageBudgetAccountedEntryComponents(params.owner);
  const current = usageBudgetAccountedEntryComponents(params.entry);
  if (usageBudgetEntryComponentsExceed(current, target)) {
    return undefined;
  }
  const candidates = [
    { candidate: params.entry, index: params.entryIndex },
    ...params.entries
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate, index }) => {
        return (
          index !== params.entryIndex &&
          !params.consumedBridgeIndexes.has(index) &&
          usageBudgetBridgeCanBelongToOwner(candidate, params.owner)
        );
      }),
  ].toSorted(
    (a, b) =>
      Math.abs(a.candidate.timestampMs - params.owner.timestampMs) -
      Math.abs(b.candidate.timestampMs - params.owner.timestampMs),
  );
  const total = candidates.reduce<UsageBudgetEntryComponents>(
    (sum, candidate) =>
      addUsageBudgetEntryComponents(sum, usageBudgetAccountedEntryComponents(candidate.candidate)),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );
  if (usageBudgetEntryComponentsEqual(total, target)) {
    return candidates.map((candidate) => candidate.index);
  }
  return undefined;
}

function collectUsageBudgetBridgeSuppressions(entries: readonly AgentUsageBudgetAccountedEntry[]): {
  bridgeIndexes: Set<number>;
  ownerIndexes: Set<number>;
} {
  const consumedOwnerIndexes = new Set<number>();
  const consumedBridgeIndexes = new Set<number>();
  const suppressedBridgeIndexes = new Set<number>();
  const suppressedOwnerIndexes = new Set<number>();
  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.source !== "model_call_custom" || consumedBridgeIndexes.has(entryIndex)) {
      continue;
    }
    const ownerIndex = entries.findIndex((owner, candidateOwnerIndex) => {
      return (
        candidateOwnerIndex !== entryIndex &&
        !consumedOwnerIndexes.has(candidateOwnerIndex) &&
        owner.source !== "compaction" &&
        owner.source !== "branch_summary" &&
        owner.source !== "compaction_custom" &&
        modelCallCustomEntryMatchesCanonicalOwner(entry, owner)
      );
    });
    if (ownerIndex !== -1) {
      consumedOwnerIndexes.add(ownerIndex);
      consumedBridgeIndexes.add(entryIndex);
      suppressedOwnerIndexes.add(ownerIndex);
      continue;
    }
    const aggregateOwner = entries
      .map((owner, index) => ({ owner, index }))
      .find(({ owner, index }) => {
        if (index === entryIndex || consumedOwnerIndexes.has(index)) {
          return false;
        }
        if (
          owner.source !== "compaction" &&
          owner.source !== "branch_summary" &&
          owner.source !== "compaction_custom"
        ) {
          return false;
        }
        const subset = findUsageBudgetBridgeSubsetForOwner({
          entry,
          entryIndex,
          owner,
          entries,
          consumedBridgeIndexes,
        });
        if (!subset) {
          return false;
        }
        reconcileAggregateUsageBudgetBridgeOwnerCost(
          owner,
          subset.map((bridgeIndex) => entries[bridgeIndex]).filter(Boolean),
        );
        consumedOwnerIndexes.add(index);
        for (const bridgeIndex of subset) {
          consumedBridgeIndexes.add(bridgeIndex);
          suppressedBridgeIndexes.add(bridgeIndex);
        }
        return true;
      });
    if (!aggregateOwner) {
      continue;
    }
  }
  return { bridgeIndexes: suppressedBridgeIndexes, ownerIndexes: suppressedOwnerIndexes };
}

function summarizeUsageBudgetAccountedEntries(params: {
  entries: readonly AgentUsageBudgetAccountedEntry[];
  window: UsageBudgetWindow;
  endMs: number;
}): UsageBudgetWindowTotals {
  const summary = createEmptyUsageBudgetWindowTotals();
  const seenDedupKeys = new Set<string>();
  const entries = deduplicateUsageBudgetAccountedEntries(params.entries);
  const suppressions = collectUsageBudgetBridgeSuppressions(entries);
  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.dedupKey) {
      if (seenDedupKeys.has(entry.dedupKey)) {
        continue;
      }
      seenDedupKeys.add(entry.dedupKey);
    }
    if (entry.timestampMs < params.window.startMs || entry.timestampMs > params.endMs) {
      continue;
    }
    if (suppressions.bridgeIndexes.has(entryIndex) || suppressions.ownerIndexes.has(entryIndex)) {
      continue;
    }
    summary.totalTokens += entry.totalTokens;
    summary.totalCost += entry.totalCost;
    summary.missingCostEntries += entry.missingCostEntries;
    summary.missingTokenUsageEntries += entry.missingTokenUsageEntries;
    summary.missingSpendEvidenceEntries += entry.missingSpendEvidenceEntries;
  }
  return summary;
}

export function recordAgentUsageBudgetAdmissionResult(params: {
  config?: OpenClawConfig;
  agentId?: string | null;
  provider: string;
  model: string;
  usage?: UsageLike;
  timestampMs?: number;
  recordId?: string;
  usageBudgetBridge?: boolean;
  usageBudgetOperationId?: string;
}): void {
  const agentId = resolveAgentUsageBudgetAgentId(params);
  let timestampMs = params.timestampMs ?? Date.now();
  try {
    timestampMs =
      params.timestampMs ??
      readAgentUsageBudgetInFlightTimestampMs({
        agentId,
        usageBudgetOperationId: params.usageBudgetOperationId,
      }) ??
      timestampMs;
    const entry: PendingUsageBudgetEntry = {
      provider: params.provider,
      model: params.model,
      timestampMs,
      usage: params.usage ? normalizeUsage(params.usage) : undefined,
    };
    const entries = prunePendingUsageBudgetEntries(agentId, entry.timestampMs);
    entries.push(entry);
    pendingUsageBudgetEntriesByAgent.set(agentId, entries);
    writeAgentUsageBudgetLedgerEntry({
      config: params.config,
      agentId,
      provider: params.provider,
      model: params.model,
      usage: params.usage,
      timestampMs,
      recordId: params.recordId,
      usageBudgetBridge: params.usageBudgetBridge,
      usageAccountingSource: params.usageBudgetBridge ? "model_call_custom" : "message",
      ...(params.usageBudgetOperationId
        ? { usageBudgetOperationId: params.usageBudgetOperationId }
        : {}),
    });
  } catch (error) {
    rememberUsageBudgetRecordFailure({
      config: params.config,
      agentId,
      timestampMs,
    });
    throw buildUsageBudgetRecordFailedError({
      agentId,
      provider: params.provider,
      model: params.model,
      cause: error,
    });
  }
}

function buildUsageBudgetLedgerSyntheticEntry(params: {
  recordId: string;
  provider: string;
  model: string;
  usage?: UsageLike;
  timestampMs: number;
  usageAccountingSource: AgentUsageBudgetAccountedEntry["source"];
  usageBudgetBridge?: boolean;
  usageBudgetOperationId?: string;
}): Record<string, unknown> {
  const message = {
    role: "assistant",
    content: [],
    provider: params.provider,
    model: params.model,
    usage: params.usage,
    stopReason: params.usage ? "stop" : "error",
    timestamp: params.timestampMs,
  };
  if (params.usageAccountingSource === "compaction") {
    return {
      type: "compaction",
      id: params.recordId,
      timestamp: new Date(params.timestampMs).toISOString(),
      usageAccounting: {
        provider: params.provider,
        model: params.model,
        usage: params.usage,
        ...(params.usageBudgetOperationId
          ? { [USAGE_BUDGET_OPERATION_ID_KEY]: params.usageBudgetOperationId }
          : {}),
      },
    };
  }
  if (params.usageAccountingSource === "branch_summary") {
    return {
      type: "branch_summary",
      id: params.recordId,
      timestamp: new Date(params.timestampMs).toISOString(),
      usageAccounting: {
        provider: params.provider,
        model: params.model,
        usage: params.usage,
        ...(params.usageBudgetOperationId
          ? { [USAGE_BUDGET_OPERATION_ID_KEY]: params.usageBudgetOperationId }
          : {}),
      },
    };
  }
  const customType =
    params.usageAccountingSource === "compaction_custom"
      ? COMPACTION_USAGE_ACCOUNTING_CUSTOM_TYPE
      : MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE;
  if (params.usageAccountingSource !== "message") {
    return {
      type: "custom",
      customType,
      id: params.recordId,
      timestamp: new Date(params.timestampMs).toISOString(),
      appendMode: "side",
      data: {
        schemaVersion: 1,
        ...(params.usageBudgetBridge || params.usageAccountingSource === "model_call_custom"
          ? { usageBudgetBridge: true }
          : {}),
        ...(params.usageBudgetOperationId
          ? { [USAGE_BUDGET_OPERATION_ID_KEY]: params.usageBudgetOperationId }
          : {}),
        message,
      },
    };
  }
  return {
    type: "custom",
    customType: MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE,
    id: params.recordId,
    timestamp: new Date(params.timestampMs).toISOString(),
    appendMode: "side",
    data: {
      schemaVersion: 1,
      ...(params.usageBudgetOperationId
        ? { [USAGE_BUDGET_OPERATION_ID_KEY]: params.usageBudgetOperationId }
        : {}),
      message,
    },
  };
}

function stringifyUsageBudgetLedgerUsage(usage: UsageLike | undefined): string | null {
  if (usage === undefined) {
    return null;
  }
  try {
    return JSON.stringify(usage);
  } catch {
    return null;
  }
}

function parseUsageBudgetLedgerUsage(value: string | null): UsageLike | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? (parsed as UsageLike) : undefined;
  } catch {
    return undefined;
  }
}

function writeAgentUsageBudgetLedgerEntry(params: {
  config?: OpenClawConfig;
  agentId: string;
  dedupKey?: string;
  provider: string;
  model: string;
  usage?: UsageLike;
  timestampMs: number;
  recordId?: string;
  usageAccountingSource: AgentUsageBudgetAccountedEntry["source"];
  usageBudgetBridge?: boolean;
  usageBudgetInFlight?: boolean;
  usageBudgetOperationId?: string;
}): string {
  const recordId = params.recordId ?? `usage-budget:${params.timestampMs}:${randomUUID()}`;
  const syntheticEntry = buildUsageBudgetLedgerSyntheticEntry({
    recordId,
    provider: params.provider,
    model: params.model,
    usage: params.usage,
    timestampMs: params.timestampMs,
    usageAccountingSource: params.usageAccountingSource,
    usageBudgetBridge: params.usageBudgetBridge,
    ...(params.usageBudgetOperationId
      ? { usageBudgetOperationId: params.usageBudgetOperationId }
      : {}),
  });
  const accounted = readUsageBudgetAccountedEntry({
    entry: syntheticEntry,
    config: params.config,
  });
  const canonicalDedupKey =
    params.dedupKey ??
    accounted?.dedupKey ??
    [
      recordId,
      params.timestampMs,
      params.provider,
      params.model,
      params.usage ? JSON.stringify(normalizeUsage(params.usage) ?? null) : "",
    ].join("|");
  const dedupKey = buildAgentScopedUsageBudgetLedgerKey(params.agentId, canonicalDedupKey);
  const updatedAtMs = Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<AgentUsageBudgetLedgerDatabase>(db);
    if (params.usageBudgetOperationId && !params.usageBudgetInFlight) {
      executeSqliteQuerySync(
        db,
        stateDb
          .deleteFrom("agent_usage_budget_ledger")
          .where("agent_id", "=", params.agentId)
          .where("usage_budget_operation_id", "=", params.usageBudgetOperationId)
          .where("record_id", "like", `${USAGE_BUDGET_IN_FLIGHT_RECORD_ID_PREFIX}%`),
      );
    }
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("agent_usage_budget_ledger")
        .values({
          dedup_key: dedupKey,
          agent_id: params.agentId,
          record_id: recordId,
          provider: params.provider,
          model: params.model,
          timestamp_ms: params.timestampMs,
          usage_accounting_source: params.usageAccountingSource,
          usage_json: stringifyUsageBudgetLedgerUsage(params.usage),
          usage_budget_bridge: params.usageBudgetBridge ? 1 : 0,
          usage_budget_operation_id: params.usageBudgetOperationId ?? null,
          updated_at_ms: updatedAtMs,
        })
        .onConflict((conflict) =>
          conflict.column("dedup_key").doUpdateSet({
            agent_id: (eb) => eb.ref("excluded.agent_id"),
            record_id: (eb) => eb.ref("excluded.record_id"),
            provider: (eb) => eb.ref("excluded.provider"),
            model: (eb) => eb.ref("excluded.model"),
            timestamp_ms: (eb) => eb.ref("excluded.timestamp_ms"),
            usage_accounting_source: (eb) => eb.ref("excluded.usage_accounting_source"),
            usage_json: (eb) => eb.ref("excluded.usage_json"),
            usage_budget_bridge: (eb) => eb.ref("excluded.usage_budget_bridge"),
            usage_budget_operation_id: (eb) => eb.ref("excluded.usage_budget_operation_id"),
            updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
          }),
        ),
    );
  });
  return dedupKey;
}

function deleteAgentUsageBudgetLedgerEntryByDedupKey(dedupKey: string): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<AgentUsageBudgetLedgerDatabase>(db);
    executeSqliteQuerySync(
      db,
      stateDb.deleteFrom("agent_usage_budget_ledger").where("dedup_key", "=", dedupKey),
    );
  });
}

function readAgentUsageBudgetInFlightTimestampMs(params: {
  agentId: string;
  usageBudgetOperationId?: string;
}): number | undefined {
  if (!params.usageBudgetOperationId) {
    return undefined;
  }
  const database = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<AgentUsageBudgetLedgerDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("agent_usage_budget_ledger")
      .select("timestamp_ms")
      .where("agent_id", "=", params.agentId)
      .where("usage_budget_operation_id", "=", params.usageBudgetOperationId)
      .where("record_id", "like", `${USAGE_BUDGET_IN_FLIGHT_RECORD_ID_PREFIX}%`)
      .orderBy("timestamp_ms", "desc")
      .limit(1),
  ).rows;
  const timestampMs = rows[0]?.timestamp_ms;
  return typeof timestampMs === "number" && Number.isFinite(timestampMs) ? timestampMs : undefined;
}

export function loadAgentUsageBudgetLedgerAccountedEntries(params: {
  agentId?: string | null;
  minStartMs: number;
  config?: OpenClawConfig;
}): AgentUsageBudgetAccountedEntry[] {
  const agentId = resolveAgentUsageBudgetAgentId(params);
  const database = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<AgentUsageBudgetLedgerDatabase>(database.db);
  let query = stateDb
    .selectFrom("agent_usage_budget_ledger")
    .select([
      "agent_id",
      "dedup_key",
      "record_id",
      "provider",
      "model",
      "timestamp_ms",
      "usage_accounting_source",
      "usage_json",
      "usage_budget_bridge",
      "usage_budget_operation_id",
    ])
    .where("timestamp_ms", ">=", params.minStartMs);
  query = query.where("agent_id", "=", agentId);
  const rows = executeSqliteQuerySync(
    database.db,
    query.orderBy("timestamp_ms", "asc").orderBy("dedup_key", "asc"),
  ).rows as AgentUsageBudgetLedgerRow[];
  const entries: AgentUsageBudgetAccountedEntry[] = [];
  for (const row of rows) {
    const accounted = readUsageBudgetAccountedEntry({
      entry: buildUsageBudgetLedgerSyntheticEntry({
        recordId: row.record_id,
        provider: row.provider,
        model: row.model,
        usage: parseUsageBudgetLedgerUsage(row.usage_json),
        timestampMs: row.timestamp_ms,
        usageAccountingSource: normalizeUsageAccountingSource(row.usage_accounting_source),
        usageBudgetBridge: row.usage_budget_bridge === 1,
        ...(row.usage_budget_operation_id
          ? { usageBudgetOperationId: row.usage_budget_operation_id }
          : {}),
      }),
      config: params.config,
    });
    if (accounted) {
      entries.push({
        ...accounted,
        dedupKey: readAgentScopedUsageBudgetLedgerKey(row.dedup_key, row.agent_id),
      });
    }
  }
  return entries;
}

function loadAgentUsageBudgetTranscriptImportState(
  agentId: string,
): AgentUsageBudgetTranscriptImportStateRow | undefined {
  const database = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<AgentUsageBudgetLedgerDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("agent_usage_budget_transcript_import_state")
      .select([
        "agent_id",
        "imported_min_start_ms",
        "sessions_dir_exists",
        "sessions_dir_mtime_ms",
        "sessions_dirs_fingerprint",
        "active_transcript_path",
        "active_transcript_size",
        "active_transcript_mtime_ms",
        "updated_at_ms",
      ])
      .where("agent_id", "=", agentId),
  ).rows as AgentUsageBudgetTranscriptImportStateRow[];
  return rows[0];
}

function writeAgentUsageBudgetTranscriptImportState(params: {
  agentId: string;
  importedMinStartMs: number;
  sessionsDir: UsageBudgetSessionsDirState;
}): void {
  const updatedAtMs = Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<AgentUsageBudgetLedgerDatabase>(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("agent_usage_budget_transcript_import_state")
        .values({
          agent_id: params.agentId,
          imported_min_start_ms: params.importedMinStartMs,
          sessions_dir_exists: params.sessionsDir.exists ? 1 : 0,
          sessions_dir_mtime_ms: params.sessionsDir.mtimeMs,
          sessions_dirs_fingerprint: params.sessionsDir.dirsFingerprint,
          active_transcript_path: params.sessionsDir.activeFile?.path ?? null,
          active_transcript_size: params.sessionsDir.activeFile?.size ?? null,
          active_transcript_mtime_ms: params.sessionsDir.activeFile?.mtimeMs ?? null,
          updated_at_ms: updatedAtMs,
        })
        .onConflict((conflict) =>
          conflict.column("agent_id").doUpdateSet({
            imported_min_start_ms: (eb) => eb.ref("excluded.imported_min_start_ms"),
            sessions_dir_exists: (eb) => eb.ref("excluded.sessions_dir_exists"),
            sessions_dir_mtime_ms: (eb) => eb.ref("excluded.sessions_dir_mtime_ms"),
            sessions_dirs_fingerprint: (eb) => eb.ref("excluded.sessions_dirs_fingerprint"),
            active_transcript_path: (eb) => eb.ref("excluded.active_transcript_path"),
            active_transcript_size: (eb) => eb.ref("excluded.active_transcript_size"),
            active_transcript_mtime_ms: (eb) => eb.ref("excluded.active_transcript_mtime_ms"),
            updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
          }),
        ),
    );
  });
}

function resolveUsageBudgetTranscriptDirs(params: {
  agentId: string;
  config?: OpenClawConfig;
  transcriptPath?: string;
}): string[] {
  const dirs = new Set<string>();
  dirs.add(path.resolve(resolveSessionTranscriptsDirForAgent(params.agentId)));
  const configuredStore = params.config?.session?.store;
  // Shared session stores do not encode agent ownership in their path; only
  // bulk-import stores whose directory is already agent-scoped.
  if (configuredStore && usageBudgetSessionStoreHasAgentScopedDirectory(configuredStore)) {
    dirs.add(path.dirname(resolveStorePath(configuredStore, { agentId: params.agentId })));
  }
  return [...dirs].toSorted();
}

function usageBudgetSessionStoreHasAgentScopedDirectory(store: string): boolean {
  const dir = path.dirname(store);
  return dir !== "." && dir.includes("{agentId}");
}

function usageBudgetTranscriptImportStateMatches(params: {
  importState: AgentUsageBudgetTranscriptImportStateRow | null | undefined;
  minStartMs: number;
  sessionsDir: UsageBudgetSessionsDirState;
}): boolean {
  const importState = params.importState;
  if (!importState || importState.imported_min_start_ms > params.minStartMs) {
    return false;
  }
  if (importState.sessions_dirs_fingerprint !== params.sessionsDir.dirsFingerprint) {
    return false;
  }
  const activeFile = params.sessionsDir.activeFile;
  return (
    importState.active_transcript_path === (activeFile?.path ?? null) &&
    importState.active_transcript_size === (activeFile?.size ?? null) &&
    importState.active_transcript_mtime_ms === (activeFile?.mtimeMs ?? null)
  );
}

function parseUsageBudgetSessionsFingerprint(
  value: string | null | undefined,
): UsageBudgetSessionsFingerprint | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.dirs) || !Array.isArray(parsed.files)) {
      return undefined;
    }
    const dirs = parsed.dirs
      .map((entry) => {
        if (!isRecord(entry) || typeof entry.path !== "string") {
          return null;
        }
        return {
          path: entry.path,
          exists: entry.exists === true,
          mtimeMs: typeof entry.mtimeMs === "number" ? entry.mtimeMs : null,
        };
      })
      .filter((entry): entry is UsageBudgetSessionsDirState["dirs"][number] => entry !== null);
    const files = parsed.files
      .map((entry) => {
        if (!isRecord(entry) || typeof entry.path !== "string") {
          return null;
        }
        return {
          path: entry.path,
          exists: entry.exists === true,
          mtimeMs: typeof entry.mtimeMs === "number" ? entry.mtimeMs : null,
          size: typeof entry.size === "number" ? entry.size : null,
        };
      })
      .filter((entry): entry is UsageBudgetSessionsDirState["files"][number] => entry !== null);
    return { dirs, files };
  } catch {
    return undefined;
  }
}

function usageBudgetSessionsDirsMatch(
  left: UsageBudgetSessionsDirState["dirs"],
  right: UsageBudgetSessionsDirState["dirs"],
): boolean {
  return stableStringify(left) === stableStringify(right);
}

function assertUsageBudgetSessionStoreIsAgentScoped(params: {
  agentId: string;
  config?: OpenClawConfig;
}): void {
  const configuredStore = params.config?.session?.store;
  if (!configuredStore || usageBudgetSessionStoreHasAgentScopedDirectory(configuredStore)) {
    return;
  }
  const resolvedStore = resolveStorePath(configuredStore, { agentId: params.agentId });
  const defaultStore = resolveStorePath(undefined, { agentId: params.agentId });
  if (resolvedStore === defaultStore) {
    return;
  }
  throw new Error(
    "usage-budget transcript backfill requires session.store to be agent-scoped with {agentId}",
  );
}

async function statUsageBudgetSessionsDirs(params: {
  agentId: string;
  config?: OpenClawConfig;
  transcriptPath?: string;
  fallbackTranscriptPath?: string;
  importState?: AgentUsageBudgetTranscriptImportStateRow | null;
}): Promise<UsageBudgetSessionsDirState> {
  const sessionsDirs = resolveUsageBudgetTranscriptDirs(params);
  let activeFile: UsageBudgetSessionsDirState["activeFile"];
  const activePath = params.transcriptPath ?? params.fallbackTranscriptPath;
  if (activePath) {
    try {
      const activeStats = await fs.promises.stat(activePath);
      if (activeStats.isFile()) {
        activeFile = {
          path: activePath,
          size: activeStats.size,
          mtimeMs: activeStats.mtimeMs,
        };
      }
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  const dirs: UsageBudgetSessionsDirState["dirs"] = [];
  for (const sessionsDir of sessionsDirs) {
    try {
      const stats = await fs.promises.stat(sessionsDir);
      const exists = stats.isDirectory();
      dirs.push({
        path: sessionsDir,
        exists,
        mtimeMs: exists ? stats.mtimeMs : null,
      });
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        dirs.push({ path: sessionsDir, exists: false, mtimeMs: null });
        continue;
      }
      throw error;
    }
  }
  const previousFingerprint = parseUsageBudgetSessionsFingerprint(
    params.importState?.sessions_dirs_fingerprint,
  );
  const files: UsageBudgetSessionsDirState["files"] = [];
  const shouldEnumerateFiles =
    !previousFingerprint || !usageBudgetSessionsDirsMatch(previousFingerprint.dirs, dirs);
  const statTranscriptFile = async (
    filePath: string,
  ): Promise<UsageBudgetSessionsDirState["files"][number]> => {
    try {
      const stats = await fs.promises.stat(filePath);
      return {
        path: filePath,
        exists: stats.isFile(),
        size: stats.isFile() ? stats.size : null,
        mtimeMs: stats.isFile() ? stats.mtimeMs : null,
      };
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return { path: filePath, exists: false, size: null, mtimeMs: null };
      }
      throw error;
    }
  };
  if (shouldEnumerateFiles) {
    for (const dir of dirs) {
      if (!dir.exists) {
        continue;
      }
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = await fs.promises.readdir(dir.path, { withFileTypes: true });
      } catch (error) {
        if (isNodeErrorCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
      for (const dirEntry of dirEntries) {
        if (!dirEntry.isFile() || !isUsageCountedSessionTranscriptFileName(dirEntry.name)) {
          continue;
        }
        files.push(await statTranscriptFile(path.join(dir.path, dirEntry.name)));
      }
    }
  } else {
    for (const file of previousFingerprint.files) {
      files.push(await statTranscriptFile(file.path));
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const primary = dirs[0] ?? { exists: false, mtimeMs: null, path: "" };
  const dirsFingerprint = stableStringify({ dirs, files });
  return {
    exists: primary.exists,
    mtimeMs: primary.mtimeMs,
    dirs,
    files,
    dirsFingerprint,
    ...(activeFile ? { activeFile } : {}),
  };
}

function readUsageBudgetAccountedEntry(params: {
  entry: Record<string, unknown>;
  config?: OpenClawConfig;
  sessionId?: string;
}): AgentUsageBudgetAccountedEntry | null {
  const { entry } = params;
  const message = resolveBudgetTranscriptMessage(entry);
  const usageOnly =
    ((entry.type === "compaction" || entry.type === "branch_summary") &&
      isRecord(entry.usageAccounting)) ||
    resolveUsageBudgetAccountingMessage(entry) !== undefined;
  if (!message || (!usageOnly && message.role !== "assistant")) {
    return null;
  }
  if (!usageOnly && isTranscriptOnlyOpenClawAssistantMessage(message)) {
    return null;
  }
  const timestampMs = parseTranscriptTimestampMs(entry);
  if (timestampMs === undefined) {
    return null;
  }
  const usageRaw =
    (message.usage as UsageLike | undefined) ?? (entry.usage as UsageLike | undefined);
  const usage = normalizeUsage(usageRaw);
  const hasUsage = hasNonzeroUsage(usage);
  const recordedCostTotal = readUsageBudgetRecordedCostTotal(usageRaw);
  const hasRecordedCost = recordedCostTotal !== undefined;
  const hasUnpriceableCost = hasUsageBudgetUnpriceableCostMetadata(usageRaw);
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  const errorMessage =
    typeof (message as { errorMessage?: unknown }).errorMessage === "string"
      ? (message as { errorMessage: string }).errorMessage
      : undefined;
  const provider =
    (typeof message.provider === "string" ? message.provider : undefined) ??
    (typeof entry.provider === "string" ? entry.provider : undefined);
  const model =
    (typeof message.model === "string" ? message.model : undefined) ??
    (typeof entry.model === "string" ? entry.model : undefined);
  if (
    !usageOnly &&
    (stopReason === "error" || stopReason === "aborted") &&
    !hasUsage &&
    !hasRecordedCost &&
    isAgentUsageBudgetErrorMessage(errorMessage)
  ) {
    return null;
  }
  if (
    !usageOnly &&
    (stopReason === "error" || stopReason === "aborted") &&
    !hasUsage &&
    !hasRecordedCost &&
    (!provider || !model)
  ) {
    return null;
  }
  const usageBudgetOperationId = resolveUsageBudgetOperationId(entry);
  const accounted: AgentUsageBudgetAccountedEntry = {
    dedupKey: buildUsageBudgetRecordDedupKey(entry, { sessionId: params.sessionId }),
    recordId: readUsageBudgetRecordId(entry),
    source: resolveUsageBudgetAccountedEntrySource(entry),
    provider,
    model,
    timestampMs,
    ...(usage ? { usage } : {}),
    ...(usageRaw !== undefined ? { usageRaw } : {}),
    input: usage?.input,
    output: usage?.output,
    cacheRead: usage?.cacheRead,
    cacheWrite: usage?.cacheWrite,
    total: usage?.total,
    totalTokens: 0,
    totalCost: 0,
    missingCostEntries: 0,
    missingTokenUsageEntries: 0,
    missingSpendEvidenceEntries: 0,
    ...(usageBudgetOperationId ? { usageBudgetOperationId } : {}),
  };

  if (
    usage &&
    (usageTokenTotal(usage) > 0 || hasExplicitProviderAccountedZeroUsage(usage, usageRaw))
  ) {
    accounted.totalTokens = usageTokenTotal(usage);
    if (hasUnpriceableCost) {
      accounted.missingCostEntries = 1;
      accounted.missingSpendEvidenceEntries = 1;
      return accounted;
    }
    const accountedCost = resolveUsageBudgetAccountedCostTotal({
      usage,
      usageRaw,
      config: params.config,
      provider,
      model,
    });
    if (accountedCost === undefined) {
      accounted.missingCostEntries = 1;
      accounted.missingSpendEvidenceEntries = 1;
    } else {
      accounted.totalCost = accountedCost;
    }
    return accounted;
  }

  accounted.missingTokenUsageEntries = 1;
  if (hasRecordedCost) {
    accounted.totalCost = recordedCostTotal;
  } else {
    if (usageRaw !== undefined) {
      accounted.missingCostEntries = 1;
    }
    accounted.missingSpendEvidenceEntries = 1;
  }
  return accounted;
}

type UsageBudgetJsonlRecord = {
  record: Record<string, unknown>;
  lineIndex: number;
  lineText: string;
};

async function* readUsageBudgetJsonlRecords(params: {
  filePath: string;
  startOffset?: number;
}): AsyncGenerator<UsageBudgetJsonlRecord> {
  const fileStream = fs.createReadStream(params.filePath, {
    encoding: "utf8",
    ...(params.startOffset && params.startOffset > 0 ? { start: params.startOffset } : {}),
  });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let lineIndex = 0;
  try {
    for await (const line of rl) {
      const currentLineIndex = lineIndex;
      lineIndex += 1;
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isRecord(parsed)) {
          yield { record: parsed, lineIndex: currentLineIndex, lineText: trimmed };
          continue;
        }
        throw new Error(
          `malformed usage transcript row in ${params.filePath}:${currentLineIndex + 1}`,
        );
      } catch (error) {
        throw new Error(
          `malformed usage transcript JSON in ${params.filePath}:${currentLineIndex + 1}`,
          { cause: error },
        );
      }
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }
}

function buildStableLegacyTranscriptRowFingerprint(params: {
  usageIdentitySessionId: string;
  record: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(params.usageIdentitySessionId)
    .update("\0")
    .update(stableStringify(params.record))
    .digest("hex")
    .slice(0, 32);
}

function resolveUsageBudgetTranscriptIdentitySessionId(params: {
  filePath: string;
  fallbackSessionId: string;
  header: Record<string, unknown>;
}): string {
  const usageFamilyKey = resolveUsageBudgetTranscriptUsageFamilyKey({
    filePath: params.filePath,
    fallbackSessionId: params.fallbackSessionId,
    header: params.header,
  });
  if (usageFamilyKey) {
    return usageFamilyKey;
  }
  const parentSession =
    typeof params.header.parentSession === "string" ? params.header.parentSession.trim() : "";
  if (!parentSession) {
    return params.fallbackSessionId;
  }
  const parentPath = path.isAbsolute(parentSession)
    ? parentSession
    : path.resolve(path.dirname(params.filePath), parentSession);
  return (
    parseUsageCountedSessionIdFromFileName(path.basename(parentPath)) ?? params.fallbackSessionId
  );
}

const USAGE_BUDGET_TRANSCRIPT_HEADER_READ_BYTES = 64 * 1024;

function readUsageBudgetTranscriptHeader(filePath: string): Record<string, unknown> | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(USAGE_BUDGET_TRANSCRIPT_HEADER_READ_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/u, 1)[0]?.trim();
    if (!firstLine) {
      return undefined;
    }
    const parsed = JSON.parse(firstLine) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function resolveUsageBudgetTranscriptUsageFamilyKey(params: {
  filePath: string;
  fallbackSessionId: string;
  header: Record<string, unknown>;
  visited?: Set<string>;
}): string | undefined {
  const visited = params.visited ?? new Set<string>();
  const currentPath = path.resolve(params.filePath);
  if (visited.has(currentPath)) {
    return params.fallbackSessionId;
  }
  visited.add(currentPath);
  return (
    resolveSessionHeaderUsageFamilyKey({
      header: params.header,
      resolveParentUsageFamilyKey: (parentSession) => {
        const parentPath = path.isAbsolute(parentSession)
          ? parentSession
          : path.resolve(path.dirname(params.filePath), parentSession);
        const parentHeader = readUsageBudgetTranscriptHeader(parentPath);
        if (!parentHeader) {
          return undefined;
        }
        return resolveUsageBudgetTranscriptUsageFamilyKey({
          filePath: parentPath,
          fallbackSessionId:
            parseUsageCountedSessionIdFromFileName(path.basename(parentPath)) ??
            params.fallbackSessionId,
          header: parentHeader,
          visited,
        });
      },
    }) ?? params.fallbackSessionId
  );
}

function buildLegacyTranscriptBackfillKey(params: {
  rowFingerprint: string;
  occurrenceIndex: number;
  entry: AgentUsageBudgetAccountedEntry;
}): string {
  return [
    "legacy-transcript",
    params.rowFingerprint,
    params.occurrenceIndex,
    params.entry.timestampMs,
    params.entry.provider ?? "",
    params.entry.model ?? "",
  ].join("|");
}

function usageBudgetTranscriptArchiveTimestamp(filePath?: string): number {
  if (!filePath) {
    return Number.NEGATIVE_INFINITY;
  }
  const fileName = path.basename(filePath);
  return (
    parseSessionArchiveTimestamp(fileName, "reset") ??
    parseSessionArchiveTimestamp(fileName, "deleted") ??
    Number.NEGATIVE_INFINITY
  );
}

function usageBudgetTranscriptSourceRank(entry: AgentUsageBudgetAccountedEntry): number {
  const filePath = entry.sourceFilePath;
  if (!filePath) {
    return 2;
  }
  return isPrimarySessionTranscriptFileName(path.basename(filePath)) ? 0 : 1;
}

function usageBudgetEntryEvidenceGapScore(entry: AgentUsageBudgetAccountedEntry): number {
  return (
    entry.missingTokenUsageEntries + entry.missingCostEntries + entry.missingSpendEvidenceEntries
  );
}

function compareUsageBudgetDuplicateEntries(
  left: AgentUsageBudgetAccountedEntry,
  right: AgentUsageBudgetAccountedEntry,
): number {
  const sourceRankDelta =
    usageBudgetTranscriptSourceRank(left) - usageBudgetTranscriptSourceRank(right);
  if (sourceRankDelta !== 0) {
    return sourceRankDelta;
  }
  const archiveDelta =
    usageBudgetTranscriptArchiveTimestamp(right.sourceFilePath) -
    usageBudgetTranscriptArchiveTimestamp(left.sourceFilePath);
  if (archiveDelta !== 0) {
    return archiveDelta;
  }
  const evidenceDelta =
    usageBudgetEntryEvidenceGapScore(left) - usageBudgetEntryEvidenceGapScore(right);
  if (evidenceDelta !== 0) {
    return evidenceDelta;
  }
  const timestampDelta = right.timestampMs - left.timestampMs;
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  return stableStringify(left).localeCompare(stableStringify(right));
}

function deduplicateUsageBudgetAccountedEntries(
  entries: readonly AgentUsageBudgetAccountedEntry[],
): AgentUsageBudgetAccountedEntry[] {
  const byDedupKey = new Map<string, AgentUsageBudgetAccountedEntry>();
  const passthrough: AgentUsageBudgetAccountedEntry[] = [];
  for (const entry of entries) {
    if (!entry.dedupKey) {
      passthrough.push(entry);
      continue;
    }
    const existing = byDedupKey.get(entry.dedupKey);
    if (!existing || compareUsageBudgetDuplicateEntries(entry, existing) < 0) {
      byDedupKey.set(entry.dedupKey, entry);
    }
  }
  return collapseUsageBudgetLedgerTranscriptRecordDuplicates([
    ...passthrough,
    ...byDedupKey.values(),
  ]).toSorted(
    (left, right) =>
      left.timestampMs - right.timestampMs ||
      (left.dedupKey ?? "").localeCompare(right.dedupKey ?? ""),
  );
}

function collapseUsageBudgetLedgerTranscriptRecordDuplicates(
  entries: readonly AgentUsageBudgetAccountedEntry[],
): AgentUsageBudgetAccountedEntry[] {
  const byRecordId = new Map<string, AgentUsageBudgetAccountedEntry[]>();
  for (const entry of entries) {
    if (!entry.recordId) {
      continue;
    }
    const group = byRecordId.get(entry.recordId) ?? [];
    group.push(entry);
    byRecordId.set(entry.recordId, group);
  }
  const consumed = new Set<AgentUsageBudgetAccountedEntry>();
  const collapsed: AgentUsageBudgetAccountedEntry[] = [];
  for (const group of byRecordId.values()) {
    const scopedEntries = group.filter((entry) => {
      const parsed = parseUsageBudgetRecordDedupKey(entry.dedupKey);
      return parsed ? parsed.entryId === entry.recordId && parsed.sessionId.length > 0 : false;
    });
    if (group.length > 1 && scopedEntries.length === 1) {
      const canonical = group.toSorted(compareUsageBudgetDuplicateEntries)[0];
      if (canonical) {
        collapsed.push(canonical);
      }
      for (const entry of group) {
        consumed.add(entry);
      }
      continue;
    }
    if (
      group.length > 1 &&
      group.some((entry) => entry.sourceFilePath) &&
      group.some((entry) => !entry.sourceFilePath) &&
      scopedEntries.length === 0
    ) {
      const canonical = group.toSorted(compareUsageBudgetDuplicateEntries)[0];
      if (canonical) {
        collapsed.push(canonical);
      }
      for (const entry of group) {
        consumed.add(entry);
      }
    }
  }
  for (const entry of entries) {
    if (!consumed.has(entry)) {
      collapsed.push(entry);
    }
  }
  return collapsed;
}

async function scanUsageBudgetTranscriptFile(params: {
  filePath: string;
  config?: OpenClawConfig;
  startOffset?: number;
  usageIdentitySessionId?: string;
  legacyRowOccurrences?: Map<string, number>;
}): Promise<{
  entries: AgentUsageBudgetAccountedEntry[];
  usageIdentitySessionId: string;
  legacyRowOccurrences: Map<string, number>;
}> {
  const entries: AgentUsageBudgetAccountedEntry[] = [];
  const sessionId =
    parseUsageCountedSessionIdFromFileName(path.basename(params.filePath)) ??
    path.basename(params.filePath);
  let usageIdentitySessionId = params.usageIdentitySessionId ?? sessionId;
  const legacyRowOccurrences = new Map(params.legacyRowOccurrences ?? []);
  for await (const sourceRecord of readUsageBudgetJsonlRecords({
    filePath: params.filePath,
    startOffset: params.startOffset,
  })) {
    if (sourceRecord.record.type === "session") {
      usageIdentitySessionId = resolveUsageBudgetTranscriptIdentitySessionId({
        filePath: params.filePath,
        fallbackSessionId: sessionId,
        header: sourceRecord.record,
      });
    }
    const accounted = readUsageBudgetAccountedEntry({
      entry: sourceRecord.record,
      config: params.config,
      sessionId: usageIdentitySessionId,
    });
    if (accounted) {
      const entryWithSource = {
        ...accounted,
        sourceFilePath: params.filePath,
        sourceLineIndex: sourceRecord.lineIndex,
      };
      if (accounted.dedupKey) {
        entries.push(entryWithSource);
        continue;
      }
      const rowFingerprint = buildStableLegacyTranscriptRowFingerprint({
        usageIdentitySessionId,
        record: sourceRecord.record,
      });
      const occurrenceIndex = legacyRowOccurrences.get(rowFingerprint) ?? 0;
      legacyRowOccurrences.set(rowFingerprint, occurrenceIndex + 1);
      const legacyKey = buildLegacyTranscriptBackfillKey({
        rowFingerprint,
        occurrenceIndex,
        entry: entryWithSource,
      });
      entries.push({ ...entryWithSource, dedupKey: legacyKey, recordId: legacyKey });
    }
  }
  return { entries, usageIdentitySessionId, legacyRowOccurrences };
}

function usageBudgetTranscriptFileIdentityKey(stats: fs.Stats): string | undefined {
  if (!Number.isFinite(stats.dev) || !Number.isFinite(stats.ino) || stats.ino === 0) {
    return undefined;
  }
  return `${stats.dev}:${stats.ino}`;
}

async function readUsageBudgetTranscriptTailFingerprint(
  filePath: string,
  size: number,
): Promise<string> {
  if (size <= 0) {
    return "empty";
  }
  const length = Math.min(size, USAGE_BUDGET_TRANSCRIPT_CONTINUITY_BYTES);
  const offset = size - length;
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return createHash("sha256")
      .update(bytesRead === length ? buffer : buffer.subarray(0, bytesRead))
      .digest("hex");
  } finally {
    await handle.close();
  }
}

async function canReuseUsageBudgetTranscriptAppendCache(params: {
  filePath: string;
  stats: fs.Stats;
  cached: UsageBudgetTranscriptFileCacheEntry;
  pricingFingerprint: string;
  fileIdentityKey?: string;
}): Promise<boolean> {
  if (
    params.cached.pricingFingerprint !== params.pricingFingerprint ||
    params.stats.size <= params.cached.size ||
    !params.cached.fileIdentityKey ||
    !params.fileIdentityKey ||
    !params.cached.tailFingerprint
  ) {
    return false;
  }
  if (params.cached.fileIdentityKey !== params.fileIdentityKey) {
    return false;
  }
  const currentTailFingerprint = await readUsageBudgetTranscriptTailFingerprint(
    params.filePath,
    params.cached.size,
  );
  return currentTailFingerprint === params.cached.tailFingerprint;
}

async function scanUsageBudgetTranscriptEntries(params: {
  agentId: string;
  config?: OpenClawConfig;
  minStartMs: number;
  transcriptPath?: string;
}): Promise<{
  activeFile?: NonNullable<UsageBudgetSessionsDirState["activeFile"]>;
  entries: AgentUsageBudgetAccountedEntry[];
}> {
  const pricingFingerprint = usageBudgetPricingFingerprint(params.config);
  const cache =
    usageBudgetTranscriptFileCacheByAgent.get(params.agentId) ??
    new Map<string, UsageBudgetTranscriptFileCacheEntry>();
  let activeFile: NonNullable<UsageBudgetSessionsDirState["activeFile"]> | undefined;
  const livePaths = new Set<string>();
  const scannedPaths = new Set<string>();
  const result: AgentUsageBudgetAccountedEntry[] = [];
  const sessionsDirs = resolveUsageBudgetTranscriptDirs(params);
  const explicitTranscriptPath = params.transcriptPath
    ? path.resolve(params.transcriptPath)
    : undefined;

  const scanFile = async (filePathInput: string, forceActive: boolean): Promise<void> => {
    const filePath = path.resolve(filePathInput);
    if (scannedPaths.has(filePath)) {
      return;
    }
    scannedPaths.add(filePath);
    const fileName = path.basename(filePath);
    if (!isUsageCountedSessionTranscriptFileName(fileName)) {
      return;
    }
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(filePath);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    if (!stats.isFile()) {
      return;
    }
    livePaths.add(filePath);
    const fileIdentityKey = usageBudgetTranscriptFileIdentityKey(stats);
    if (forceActive) {
      activeFile = {
        path: filePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    } else if (
      !explicitTranscriptPath &&
      isPrimarySessionTranscriptFileName(fileName) &&
      (!activeFile || stats.mtimeMs > activeFile.mtimeMs)
    ) {
      activeFile = {
        path: filePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    }
    if (stats.mtimeMs < params.minStartMs) {
      return;
    }
    const cached = cache.get(filePath);
    if (
      cached &&
      cached.size === stats.size &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.pricingFingerprint === pricingFingerprint
    ) {
      result.push(...cached.entries.filter((entry) => entry.timestampMs >= params.minStartMs));
      return;
    }
    let entries: AgentUsageBudgetAccountedEntry[];
    let legacyRowOccurrences: Map<string, number>;
    try {
      if (
        cached &&
        (await canReuseUsageBudgetTranscriptAppendCache({
          filePath,
          stats,
          cached,
          pricingFingerprint,
          fileIdentityKey,
        }))
      ) {
        const appended = await scanUsageBudgetTranscriptFile({
          filePath,
          config: params.config,
          startOffset: cached.size,
          usageIdentitySessionId: cached.usageIdentitySessionId,
          legacyRowOccurrences: cached.legacyRowOccurrences,
        });
        entries = [...cached.entries, ...appended.entries];
        const usageIdentitySessionId = appended.usageIdentitySessionId;
        legacyRowOccurrences = appended.legacyRowOccurrences;
        cache.set(filePath, {
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          fileIdentityKey,
          tailFingerprint: await readUsageBudgetTranscriptTailFingerprint(filePath, stats.size),
          pricingFingerprint,
          usageIdentitySessionId,
          legacyRowOccurrences,
          entries,
        });
        result.push(...entries.filter((entry) => entry.timestampMs >= params.minStartMs));
      } else {
        const scanned = await scanUsageBudgetTranscriptFile({
          filePath,
          config: params.config,
        });
        entries = scanned.entries;
        const usageIdentitySessionId = scanned.usageIdentitySessionId;
        legacyRowOccurrences = scanned.legacyRowOccurrences;
        cache.set(filePath, {
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          fileIdentityKey,
          tailFingerprint: await readUsageBudgetTranscriptTailFingerprint(filePath, stats.size),
          pricingFingerprint,
          usageIdentitySessionId,
          legacyRowOccurrences,
          entries,
        });
        result.push(...entries.filter((entry) => entry.timestampMs >= params.minStartMs));
      }
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return;
      }
      throw new Error(`failed to read usage transcript ${filePath}`, { cause: error });
    }
  };

  if (explicitTranscriptPath) {
    await scanFile(explicitTranscriptPath, true);
  }

  for (const sessionsDir of sessionsDirs) {
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        dirEntries = [];
      } else {
        throw error;
      }
    }

    for (const dirEntry of dirEntries) {
      if (!dirEntry.isFile() || !isUsageCountedSessionTranscriptFileName(dirEntry.name)) {
        continue;
      }
      await scanFile(path.join(sessionsDir, dirEntry.name), false);
    }
  }

  for (const filePath of cache.keys()) {
    if (!livePaths.has(filePath)) {
      cache.delete(filePath);
    }
  }
  if (cache.size > 0) {
    usageBudgetTranscriptFileCacheByAgent.set(params.agentId, cache);
  } else {
    usageBudgetTranscriptFileCacheByAgent.delete(params.agentId);
  }
  return { ...(activeFile ? { activeFile } : {}), entries: result };
}

async function ensureUsageBudgetLedgerBackfilledFromTranscripts(params: {
  agentId: string;
  transcriptPath?: string;
  windows: UsageBudgetWindow[];
  config?: OpenClawConfig;
}): Promise<void> {
  if (params.windows.length === 0) {
    return;
  }
  assertUsageBudgetSessionStoreIsAgentScoped({
    agentId: params.agentId,
    config: params.config,
  });
  const minStartMs =
    Math.min(...params.windows.map((window) => window.startMs)) -
    USAGE_BUDGET_LEDGER_BRIDGE_LOOKBACK_MS;
  const importState = loadAgentUsageBudgetTranscriptImportState(params.agentId);
  // Steady-state calls write the SQLite ledger at admission/result time. Keep
  // transcript reads as bounded backfill; file fingerprints catch appends
  // without serializing every model call on historical transcript contents.
  const sessionsDirState = await statUsageBudgetSessionsDirs({
    agentId: params.agentId,
    config: params.config,
    transcriptPath: params.transcriptPath,
    fallbackTranscriptPath: importState?.active_transcript_path ?? undefined,
    importState,
  });
  if (
    usageBudgetTranscriptImportStateMatches({
      importState,
      minStartMs,
      sessionsDir: sessionsDirState,
    })
  ) {
    return;
  }
  const scanMinStartMs = Math.min(minStartMs, importState?.imported_min_start_ms ?? minStartMs);
  const transcriptScan = await scanUsageBudgetTranscriptEntries({
    agentId: params.agentId,
    config: params.config,
    minStartMs: scanMinStartMs,
    transcriptPath: params.transcriptPath,
  });
  const transcriptEntries = deduplicateUsageBudgetAccountedEntries(transcriptScan.entries);
  for (const entry of transcriptEntries) {
    const provider = entry.provider ?? "unknown";
    const model = entry.model ?? "unknown";
    try {
      writeAgentUsageBudgetLedgerEntry({
        config: params.config,
        agentId: params.agentId,
        dedupKey: entry.dedupKey,
        provider,
        model,
        usage: entry.usageRaw,
        timestampMs: entry.timestampMs,
        recordId: entry.recordId,
        usageAccountingSource: entry.source,
        usageBudgetBridge: entry.source === "model_call_custom",
        ...(entry.usageBudgetOperationId
          ? { usageBudgetOperationId: entry.usageBudgetOperationId }
          : {}),
      });
    } catch (error) {
      throw buildUsageBudgetRecordFailedError({
        agentId: params.agentId,
        provider,
        model,
        cause: error,
      });
    }
  }
  writeAgentUsageBudgetTranscriptImportState({
    agentId: params.agentId,
    importedMinStartMs: scanMinStartMs,
    sessionsDir: {
      ...sessionsDirState,
      activeFile: sessionsDirState.activeFile ?? transcriptScan.activeFile,
    },
  });
}

async function loadUsageBudgetAdmissionEntries(params: {
  agentId: string;
  transcriptPath?: string;
  windows: UsageBudgetWindow[];
  config?: OpenClawConfig;
}): Promise<AgentUsageBudgetAccountedEntry[]> {
  if (params.windows.length === 0) {
    return [];
  }
  const minStartMs = Math.min(...params.windows.map((window) => window.startMs));
  await ensureUsageBudgetLedgerBackfilledFromTranscripts(params);
  return loadAgentUsageBudgetLedgerAccountedEntries({
    agentId: params.agentId,
    minStartMs: minStartMs - USAGE_BUDGET_LEDGER_BRIDGE_LOOKBACK_MS,
    config: params.config,
  });
}

export async function checkAgentUsageBudgetAdmission(params: {
  config?: OpenClawConfig;
  agentId?: string | null;
  provider: string;
  model: string;
  transcriptPath?: string;
  nowMs?: number;
  reservation?: AgentUsageBudgetAdmissionReservation;
  costMultiplier?: number;
  reservationCostKnown?: boolean;
}): Promise<void> {
  const budget = resolveAgentUsageBudgetConfig({
    config: params.config,
    agentId: params.agentId,
  });
  if (!budget) {
    return;
  }

  const agentId = resolveAgentUsageBudgetAgentId(params);
  const reservation = normalizeUsageBudgetReservation(params.reservation);
  const reservationTokens = usageBudgetReservationTokenTotal(reservation);
  let modelCostConfig: ReturnType<typeof resolveModelCostConfig> | undefined;
  if (spendBudgetActive(budget)) {
    modelCostConfig = resolveModelCostConfig({
      provider: params.provider,
      model: params.model,
      config: params.config,
    });
    if (
      !isModelPricingKnownForRoute(modelCostConfig, {
        provider: params.provider,
        model: params.model,
      })
    ) {
      throw buildMissingModelPricingError({
        agentId,
        provider: params.provider,
        model: params.model,
      });
    }
    if (params.reservationCostKnown === false) {
      throw buildMissingModelPricingError({
        agentId,
        provider: params.provider,
        model: params.model,
      });
    }
  }
  const reservationCost =
    reservation &&
    modelCostConfig &&
    isModelPricingKnownForRoute(modelCostConfig, {
      provider: params.provider,
      model: params.model,
    })
      ? usageBudgetReservationCostTotal({ reservation, cost: modelCostConfig }) *
        normalizeUsageBudgetCostMultiplier(params.costMultiplier)
      : 0;

  const nowMs = params.nowMs ?? Date.now();
  const checks: UsageBudgetCheck[] = [
    budget.daily
      ? { window: resolveUsageBudgetWindow("daily", nowMs), limits: budget.daily }
      : null,
    budget.monthly
      ? { window: resolveUsageBudgetWindow("monthly", nowMs), limits: budget.monthly }
      : null,
  ].filter((entry): entry is UsageBudgetCheck => entry !== null);
  const limitedChecks = checks.filter(
    (check) => check.limits.usd !== undefined || check.limits.tokens !== undefined,
  );
  if (hasActiveUsageBudgetRecordFailure(agentId, nowMs)) {
    throw buildUsageBudgetRecordFailedError({
      agentId,
      provider: params.provider,
      model: params.model,
      cause: undefined,
    });
  }
  let transcriptEntries: AgentUsageBudgetAccountedEntry[];
  try {
    transcriptEntries = await loadUsageBudgetAdmissionEntries({
      agentId,
      transcriptPath: params.transcriptPath,
      windows: limitedChecks.map((check) => check.window),
      config: params.config,
    });
  } catch (error) {
    if (isAgentUsageBudgetError(error)) {
      throw error;
    }
    throw buildUsageBudgetScanFailedError({
      agentId,
      provider: params.provider,
      model: params.model,
      cause: error,
    });
  }

  for (const check of checks) {
    const summary = summarizeUsageBudgetAccountedEntries({
      entries: transcriptEntries,
      window: check.window,
      endMs: nowMs,
    });
    const pending = summarizePendingUsageBudgetEntries({
      agentId,
      window: check.window,
      endMs: nowMs,
      config: params.config,
      persistedEntries: transcriptEntries,
    });
    const missingCostEntries = summary.missingCostEntries + pending.missingCostEntries;
    if (check.limits.usd !== undefined && missingCostEntries > 0) {
      throw buildMissingWindowCostError({
        agentId,
        provider: params.provider,
        model: params.model,
        window: check.window,
        missingCostEntries,
      });
    }
    const missingTokenUsageEntries =
      summary.missingTokenUsageEntries + pending.missingTokenUsageEntries;
    if (check.limits.tokens !== undefined && missingTokenUsageEntries > 0) {
      throw buildMissingWindowUsageError({
        agentId,
        provider: params.provider,
        model: params.model,
        window: check.window,
        limitKind: "tokens",
        missingUsageEntries: missingTokenUsageEntries,
      });
    }
    const missingSpendEvidenceEntries =
      summary.missingSpendEvidenceEntries + pending.missingSpendEvidenceEntries;
    if (check.limits.usd !== undefined && missingSpendEvidenceEntries > 0) {
      throw buildMissingWindowUsageError({
        agentId,
        provider: params.provider,
        model: params.model,
        window: check.window,
        limitKind: "spend",
        missingUsageEntries: missingSpendEvidenceEntries,
      });
    }
    const usedCost = summary.totalCost + pending.totalCost;
    if (check.limits.usd !== undefined && usedCost >= check.limits.usd) {
      throw buildExceededError({
        agentId,
        provider: params.provider,
        model: params.model,
        window: check.window,
        limitKind: "spend",
        used: usedCost,
        limit: check.limits.usd,
      });
    }
    const reservedCost = usedCost + reservationCost;
    if (check.limits.usd !== undefined && reservedCost > check.limits.usd) {
      throw buildExceededError({
        agentId,
        provider: params.provider,
        model: params.model,
        window: check.window,
        limitKind: "spend",
        used: reservedCost,
        limit: check.limits.usd,
      });
    }
    const usedTokens = summary.totalTokens + pending.totalTokens;
    if (check.limits.tokens !== undefined && usedTokens >= check.limits.tokens) {
      throw buildExceededError({
        agentId,
        provider: params.provider,
        model: params.model,
        window: check.window,
        limitKind: "tokens",
        used: usedTokens,
        limit: check.limits.tokens,
      });
    }
    const reservedTokens = usedTokens + reservationTokens;
    if (check.limits.tokens !== undefined && reservedTokens > check.limits.tokens) {
      throw buildExceededError({
        agentId,
        provider: params.provider,
        model: params.model,
        window: check.window,
        limitKind: "tokens",
        used: reservedTokens,
        limit: check.limits.tokens,
      });
    }
  }
}

export type AgentUsageBudgetAdmissionRelease = ((options?: {
  preserveInFlight?: boolean;
}) => Promise<void>) & {
  timestampMs?: number;
};

const agentUsageBudgetAdmissionQueues = new Map<string, Promise<void>>();

function releaseAgentUsageBudgetAdmissionOnce(params: {
  key: string;
  queued: Promise<void>;
  inFlightDedupKey?: string;
  preserveInFlight?: boolean;
  lock?: FileLockHandle;
  resolveCurrent: () => void;
  released: { value: boolean };
}): Promise<void> {
  if (params.released.value) {
    return Promise.resolve();
  }
  params.released.value = true;
  return Promise.resolve()
    .then(async () => {
      try {
        if (params.inFlightDedupKey && !params.preserveInFlight) {
          deleteAgentUsageBudgetLedgerEntryByDedupKey(params.inFlightDedupKey);
        }
      } finally {
        await params.lock?.release();
      }
    })
    .finally(() => {
      params.resolveCurrent();
      void params.queued.finally(() => {
        if (agentUsageBudgetAdmissionQueues.get(params.key) === params.queued) {
          agentUsageBudgetAdmissionQueues.delete(params.key);
        }
      });
    });
}

function createUsageBudgetAdmissionAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const message = reason instanceof Error ? reason.message : "Usage budget admission aborted.";
  const error = new Error(message, { cause: reason });
  error.name = "AbortError";
  return error;
}

function throwIfUsageBudgetAdmissionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createUsageBudgetAdmissionAbortError(signal);
  }
}

function waitForUsageBudgetAdmissionAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onLateResolveAfterAbort?: (value: T) => Promise<void> | void,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createUsageBudgetAdmissionAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(createUsageBudgetAdmissionAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) {
          void onLateResolveAfterAbort?.(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function resolveAgentUsageBudgetAdmissionLockFile(agentId: string): string {
  const lockId = createHash("sha256").update(agentId).digest("hex").slice(0, 32);
  return path.join(resolveStateDir(process.env), "locks", "usage-budget", `${lockId}.lock`);
}

async function acquireAgentUsageBudgetAdmissionFileLock(params: {
  agentId: string;
  provider: string;
  model: string;
}): Promise<FileLockHandle> {
  const lockFile = resolveAgentUsageBudgetAdmissionLockFile(params.agentId);
  try {
    await fs.promises.mkdir(path.dirname(lockFile), { recursive: true });
    return await acquireFileLock(lockFile, USAGE_BUDGET_ADMISSION_LOCK_OPTIONS);
  } catch (error) {
    throw buildUsageBudgetScanFailedError({
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
      cause: error,
    });
  }
}

export async function acquireAgentUsageBudgetAdmission(params: {
  config?: OpenClawConfig;
  agentId?: string | null;
  provider: string;
  model: string;
  transcriptPath?: string;
  nowMs?: number;
  reservation?: AgentUsageBudgetAdmissionReservation;
  costMultiplier?: number;
  reservationCostKnown?: boolean;
  usageBudgetOperationId?: string;
  signal?: AbortSignal;
}): Promise<AgentUsageBudgetAdmissionRelease | undefined> {
  if (!resolveAgentUsageBudgetConfig({ config: params.config, agentId: params.agentId })) {
    return undefined;
  }
  throwIfUsageBudgetAdmissionAborted(params.signal);

  const agentId = resolveAgentUsageBudgetAgentId(params);
  const previous = agentUsageBudgetAdmissionQueues.get(agentId) ?? Promise.resolve();
  let resolveCurrent: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  agentUsageBudgetAdmissionQueues.set(agentId, queued);
  const released = { value: false };
  let inFlightDedupKey: string | undefined;
  let lock: FileLockHandle | undefined;
  const release: AgentUsageBudgetAdmissionRelease = ((options) =>
    releaseAgentUsageBudgetAdmissionOnce({
      key: agentId,
      queued,
      inFlightDedupKey,
      preserveInFlight: options?.preserveInFlight,
      lock,
      resolveCurrent,
      released,
    })) as AgentUsageBudgetAdmissionRelease;

  try {
    await waitForUsageBudgetAdmissionAbortable(
      previous.catch(() => undefined),
      params.signal,
    );
    lock = await waitForUsageBudgetAdmissionAbortable(
      acquireAgentUsageBudgetAdmissionFileLock({
        agentId,
        provider: params.provider,
        model: params.model,
      }),
      params.signal,
      (lateLock) => lateLock.release(),
    );
    throwIfUsageBudgetAdmissionAborted(params.signal);
    const timestampMs = params.nowMs ?? Date.now();
    await checkAgentUsageBudgetAdmission({
      ...params,
      agentId,
      nowMs: timestampMs,
    });
    throwIfUsageBudgetAdmissionAborted(params.signal);
    release.timestampMs = timestampMs;
    const usageBudgetOperationId = params.usageBudgetOperationId ?? randomUUID();
    const recordId = `${USAGE_BUDGET_IN_FLIGHT_RECORD_ID_PREFIX}${timestampMs}:${usageBudgetOperationId}`;
    inFlightDedupKey = writeAgentUsageBudgetLedgerEntry({
      config: params.config,
      agentId,
      dedupKey: recordId,
      provider: params.provider,
      model: params.model,
      timestampMs,
      recordId,
      usageAccountingSource: "model_call_custom",
      usageBudgetBridge: true,
      usageBudgetInFlight: true,
      usageBudgetOperationId,
    });
    throwIfUsageBudgetAdmissionAborted(params.signal);
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}
