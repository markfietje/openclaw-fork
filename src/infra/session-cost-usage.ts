// Persists and formats per-session cost and usage records.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  COMPACTION_USAGE_ACCOUNTING_CUSTOM_TYPE,
  MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE,
  USAGE_BUDGET_OPERATION_ID_KEY,
} from "../agents/compaction-usage-accounting.js";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  loadAgentUsageBudgetLedgerAccountedEntries,
  readUsageBudgetRecordedCostMetadata,
  readUsageBudgetRecordedCostTotal,
} from "../agents/usage-budget.js";
import type { NormalizedUsage, UsageLike } from "../agents/usage.js";
import { normalizeUsage } from "../agents/usage.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import {
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseSessionArchiveTimestamp,
  parseUsageCountedSessionIdFromFileName,
  resolveSessionHeaderUsageFamilyKey,
} from "../config/sessions/artifacts.js";
import {
  resolveSessionFilePath,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { stripEnvelope, stripMessageIdHints } from "../shared/chat-envelope.js";
import { hasUsageBudgetUnpriceableCostMetadata } from "../shared/usage-budget-recorded-cost.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { countToolResults, extractToolCallNames } from "../utils/transcript-tools.js";
import {
  estimateUsageCost,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "../utils/usage-format.js";
import { formatErrorMessage } from "./errors.js";
import { replaceFileAtomic } from "./replace-file.js";
import {
  addCostUsageTotals as addTotals,
  cloneCostUsageTotals as cloneTotals,
  createEmptyCostUsageTotals as emptyTotals,
} from "./session-cost-usage-totals.js";
import type {
  CostBreakdown,
  CostUsageTotals,
  CostUsageSummary,
  DiscoveredSession,
  ParsedTranscriptEntry,
  ParsedUsageEntry,
  SessionCostSummary,
  SessionDailyLatency,
  SessionDailyMessageCounts,
  SessionDailyModelUsage,
  SessionDailyUsage,
  SessionLatencyStats,
  SessionLogEntry,
  SessionMessageCounts,
  SessionModelUsage,
  SessionUtcQuarterHourMessageCounts,
  SessionUtcQuarterHourTokenUsage,
  SessionToolUsage,
  SessionUsageTimePoint,
  SessionUsageTimeSeries,
  UsageAccountingSource,
  UsageCacheStatus,
} from "./session-cost-usage.types.js";

export type {
  CostUsageSummary,
  CostUsageTotals,
  DiscoveredSession,
  SessionCostSummary,
  SessionDailyLatency,
  SessionDailyModelUsage,
  SessionLatencyStats,
  SessionMessageCounts,
  SessionModelUsage,
  SessionToolUsage,
  UsageCacheStatus,
} from "./session-cost-usage.types.js";

// Bump when the *meaning* of cached totals changes (not just their inputs), so durable
// caches written by older builds are rebuilt instead of served stale. Version 11
// reconciles budget-ledger and aggregate-compaction rows while preserving authoritative
// provider-zero costs and recomputing fabricated zeros for known-priced usage.
const USAGE_COST_CACHE_VERSION = 11;
const USAGE_COST_CACHE_FILE = ".usage-cost-cache.json";
const USAGE_COST_CACHE_LOCK_WRITE_GRACE_MS = 10_000;
const USAGE_COST_CACHE_TEMP_FILE_GRACE_MS = USAGE_COST_CACHE_LOCK_WRITE_GRACE_MS;
const USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY = 32;
// Checkpoint policy for refreshCostUsageCache: bound the cost of full cache
// serialization when scanning thousands of session files. Smaller of the two
// limits triggers the next durable write.
const USAGE_COST_CACHE_CHECKPOINT_FILES = 256;
const USAGE_COST_CACHE_CHECKPOINT_INTERVAL_MS = 5_000;
const logger = createSubsystemLogger("usage-cost-cache");

type UsageCostRefreshState = {
  agentId?: string;
  cachePath: string;
  config?: OpenClawConfig;
  fullRefreshRequested: boolean;
  pendingSessionFiles: Set<string>;
  running: boolean;
  sessionsDir: string;
  timer?: ReturnType<typeof setTimeout>;
};

type UsageCostRefreshResult = "refreshed" | "busy";

const usageCostRefreshes = new Map<string, UsageCostRefreshState>();

type UsageCostCachedUsageEntry = CostUsageTotals & {
  entryId?: string;
  dedupKey?: string;
  sourceFilePath?: string;
  sourceLineIndex?: number;
  source?: UsageAccountingSource;
  usageBudgetOperationId?: string;
  usageBudgetRecordedCostTotal?: number;
  timestamp: number;
  provider?: string;
  model?: string;
};

type UsageCostCachedTranscriptEntry = {
  source?: UsageAccountingSource;
  usageBudgetOperationId?: string;
  timestamp?: number;
  role?: "user" | "assistant";
  durationMs?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  toolNames: string[];
  toolResultCounts: { total: number; errors: number };
  usageTotals?: CostUsageTotals;
};

type UsageBudgetLedgerAccountedEntry = ReturnType<
  typeof loadAgentUsageBudgetLedgerAccountedEntries
>[number];

type UsageCostCacheFileEntry = {
  filePath: string;
  size: number;
  mtimeMs: number;
  pricingFingerprint: string;
  scannedAt: number;
  usageIdentitySessionId?: string;
  legacyRowOccurrences?: Record<string, number>;
  parsedRecords: number;
  countedRecords: number;
  usageEntries: UsageCostCachedUsageEntry[];
  transcriptEntries?: UsageCostCachedTranscriptEntry[];
  totals: CostUsageTotals;
  sessionId?: string;
  sessionSummary?: SessionCostSummary;
};

type UsageCostCacheFile = {
  version: number;
  updatedAt: number;
  files: Record<string, UsageCostCacheFileEntry>;
};

type UsageCostTranscriptFile = {
  filePath: string;
  size: number;
  mtimeMs: number;
};

type UsageCostCacheLock = {
  pid: number;
  startedAt: number;
  token?: string;
};

type UsageCostCacheLockReadResult =
  | { state: "missing" }
  | { state: "valid"; lock: UsageCostCacheLock }
  | { state: "malformed"; mtimeMs: number };

function resolveUsageCostPricingFingerprint(config?: OpenClawConfig): string {
  return resolveModelCostConfigFingerprint(config);
}

function resolveUsageCostCachePath(agentId?: string): string {
  return path.join(resolveSessionTranscriptsDirForAgent(agentId), USAGE_COST_CACHE_FILE);
}

function resolveUsageCostCacheLockPath(cachePath: string): string {
  return `${cachePath}.lock`;
}

function parseUsageCostCacheLock(raw: string): UsageCostCacheLock | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const lock = parsed as Partial<UsageCostCacheLock>;
  if (
    typeof lock.pid !== "number" ||
    !Number.isInteger(lock.pid) ||
    lock.pid <= 0 ||
    typeof lock.startedAt !== "number" ||
    !Number.isFinite(lock.startedAt) ||
    (lock.token !== undefined && typeof lock.token !== "string")
  ) {
    return null;
  }
  return { pid: lock.pid, startedAt: lock.startedAt, token: lock.token };
}

async function readUsageCostCacheLockState(
  lockPath: string,
): Promise<UsageCostCacheLockReadResult> {
  try {
    const lock = parseUsageCostCacheLock(await fs.promises.readFile(lockPath, "utf-8"));
    if (lock) {
      return { state: "valid", lock };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing" };
    }
  }
  const stats = await fs.promises.stat(lockPath).catch(() => null);
  if (!stats) {
    return { state: "missing" };
  }
  return { state: "malformed", mtimeMs: stats.mtimeMs };
}

async function readUsageCostCacheLock(lockPath: string): Promise<UsageCostCacheLock | null> {
  const result = await readUsageCostCacheLockState(lockPath);
  return result.state === "valid" ? result.lock : null;
}

function isMalformedUsageCostCacheLockRecent(mtimeMs: number): boolean {
  return Date.now() - mtimeMs < USAGE_COST_CACHE_LOCK_WRITE_GRACE_MS;
}

async function writeUsageCostCacheLockAtomically(
  lockPath: string,
  lock: UsageCostCacheLock,
): Promise<void> {
  const tempPath = `${lockPath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(lock)}\n`, { flag: "wx" });
  try {
    await fs.promises.link(tempPath, lockPath);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function isUsageCostCacheRefreshRunning(cachePath: string): Promise<boolean> {
  const lockPath = resolveUsageCostCacheLockPath(cachePath);
  const result = await readUsageCostCacheLockState(lockPath);
  if (result.state === "missing") {
    return false;
  }
  if (result.state === "malformed") {
    if (isMalformedUsageCostCacheLockRecent(result.mtimeMs)) {
      return true;
    }
    await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
    return false;
  }
  const lock = result.lock;
  if (isProcessRunning(lock.pid)) {
    return true;
  }
  await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
  return false;
}

async function acquireUsageCostCacheRefreshLock(cachePath: string): Promise<{
  acquired: boolean;
  release: () => Promise<void>;
}> {
  const lockPath = resolveUsageCostCacheLockPath(cachePath);
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  const lock: UsageCostCacheLock = {
    pid: process.pid,
    startedAt: Date.now(),
    token: `${process.pid}:${Date.now()}:${process.hrtime.bigint()}`,
  };
  try {
    await writeUsageCostCacheLockAtomically(lockPath, lock);
    return {
      acquired: true,
      release: async () => {
        const current = await readUsageCostCacheLock(lockPath);
        if (
          current?.pid === lock.pid &&
          current.startedAt === lock.startedAt &&
          current.token === lock.token
        ) {
          await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
        }
      },
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw err;
    }
    if (await isUsageCostCacheRefreshRunning(cachePath)) {
      return { acquired: false, release: async () => undefined };
    }
    await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
    return acquireUsageCostCacheRefreshLock(cachePath);
  }
}

function normalizeUsageCostCache(raw: unknown): UsageCostCacheFile {
  if (!raw || typeof raw !== "object") {
    return { version: USAGE_COST_CACHE_VERSION, updatedAt: 0, files: {} };
  }
  const record = raw as Record<string, unknown>;
  if (
    record.version !== USAGE_COST_CACHE_VERSION ||
    !record.files ||
    typeof record.files !== "object"
  ) {
    return { version: USAGE_COST_CACHE_VERSION, updatedAt: 0, files: {} };
  }
  return {
    version: USAGE_COST_CACHE_VERSION,
    updatedAt: asFiniteNumber(record.updatedAt) ?? 0,
    files: record.files as Record<string, UsageCostCacheFileEntry>,
  };
}

async function readUsageCostCache(cachePath: string): Promise<UsageCostCacheFile> {
  try {
    const raw = await fs.promises.readFile(cachePath, "utf-8");
    return normalizeUsageCostCache(JSON.parse(raw));
  } catch {
    return { version: USAGE_COST_CACHE_VERSION, updatedAt: 0, files: {} };
  }
}

async function writeUsageCostCache(cachePath: string, cache: UsageCostCacheFile): Promise<void> {
  await replaceFileAtomic({
    filePath: cachePath,
    content: `${JSON.stringify(cache)}\n`,
    tempPrefix: ".usage-cost-cache",
  });
}

function isUsageCostCacheTempFileName(name: string): boolean {
  if (!name.endsWith(".tmp") || name.startsWith(`${USAGE_COST_CACHE_FILE}.lock.`)) {
    return false;
  }
  return name.startsWith(".usage-cost-cache.") || name.startsWith(`${USAGE_COST_CACHE_FILE}.`);
}

async function cleanupStaleUsageCostCacheTempFiles(cachePath: string): Promise<void> {
  const dir = path.dirname(cachePath);
  const cutoffMs = Date.now() - USAGE_COST_CACHE_TEMP_FILE_GRACE_MS;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !isUsageCostCacheTempFileName(entry.name)) {
        return;
      }
      const tempPath = path.join(dir, entry.name);
      const stats = await fs.promises.stat(tempPath).catch(() => null);
      if (!stats || stats.mtimeMs > cutoffMs) {
        return;
      }
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    }),
  );
}

async function listUsageCountedTranscriptFileStats(
  agentId?: string,
  params?: { minMtimeMs?: number; sessionsDir?: string },
): Promise<UsageCostTranscriptFile[]> {
  const sessionsDir = params?.sessionsDir ?? resolveSessionTranscriptsDirForAgent(agentId);
  const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const tasks = entries
    .filter((entry) => entry.isFile() && isUsageCountedSessionTranscriptFileName(entry.name))
    .map((entry) => async (): Promise<UsageCostTranscriptFile | undefined> => {
      const filePath = path.join(sessionsDir, entry.name);
      const stats = await fs.promises.stat(filePath).catch(() => null);
      if (!stats) {
        return undefined;
      }
      if (params?.minMtimeMs !== undefined && stats.mtimeMs < params.minMtimeMs) {
        return undefined;
      }
      return { filePath, size: stats.size, mtimeMs: stats.mtimeMs };
    });
  const { results } = await runTasksWithConcurrency({
    tasks,
    limit: USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY,
  });
  return results.filter((file): file is UsageCostTranscriptFile => Boolean(file));
}

async function listUsageCountedTranscriptFiles(
  agentId?: string,
  params?: { sessionsDir?: string },
): Promise<UsageCostTranscriptFile[]> {
  return await listUsageCountedTranscriptFileStats(agentId, params);
}

function isUsageCostCacheEntryFresh(params: {
  entry: UsageCostCacheFileEntry | undefined;
  file: UsageCostTranscriptFile;
  pricingFingerprint: string;
  requireSessionSummary?: boolean;
}): boolean {
  return Boolean(
    params.entry &&
    params.entry.size === params.file.size &&
    params.entry.mtimeMs === params.file.mtimeMs &&
    params.entry.pricingFingerprint === params.pricingFingerprint &&
    (!params.requireSessionSummary || params.entry.sessionSummary),
  );
}

function canUseUsageCostCacheEntryForPartial(params: {
  entry: UsageCostCacheFileEntry | undefined;
  file: UsageCostTranscriptFile;
  pricingFingerprint: string;
}): params is {
  entry: UsageCostCacheFileEntry;
  file: UsageCostTranscriptFile;
  pricingFingerprint: string;
} {
  return Boolean(
    params.entry &&
    params.entry.size <= params.file.size &&
    params.entry.mtimeMs <= params.file.mtimeMs &&
    params.entry.pricingFingerprint === params.pricingFingerprint,
  );
}

function getUsageCostStaleFiles(params: {
  cache: UsageCostCacheFile;
  files: UsageCostTranscriptFile[];
  pricingFingerprint: string;
  sessionSummaryFiles?: Set<string>;
}): UsageCostTranscriptFile[] {
  const sessionSummaryFiles = params.sessionSummaryFiles ?? new Set<string>();
  return params.files.filter(
    (file) =>
      !isUsageCostCacheEntryFresh({
        entry: params.cache.files[file.filePath],
        file,
        pricingFingerprint: params.pricingFingerprint,
        requireSessionSummary: sessionSummaryFiles.has(file.filePath),
      }),
  );
}

function countUsableUsageCostCacheFiles(params: {
  cache: UsageCostCacheFile;
  files: UsageCostTranscriptFile[];
  pricingFingerprint: string;
}): number {
  const filesByPath = new Map(params.files.map((file) => [file.filePath, file]));
  let cachedFiles = 0;
  for (const [filePath, entry] of Object.entries(params.cache.files)) {
    const file = filesByPath.get(filePath);
    if (
      file &&
      canUseUsageCostCacheEntryForPartial({
        entry,
        file,
        pricingFingerprint: params.pricingFingerprint,
      })
    ) {
      cachedFiles += 1;
    }
  }
  return cachedFiles;
}

function buildCostUsageSummaryFromCache(params: {
  cache: UsageCostCacheFile;
  files: UsageCostTranscriptFile[];
  ledgerEntries?: UsageBudgetLedgerAccountedEntry[];
  startMs: number;
  endMs: number;
  pricingFingerprint: string;
  refreshing: boolean;
}): CostUsageSummary {
  const dailyMap = new Map<string, CostUsageTotals>();
  const totals = emptyTotals();
  const filesByPath = new Map(params.files.map((file) => [file.filePath, file]));
  const staleFiles = getUsageCostStaleFiles({
    cache: params.cache,
    files: params.files,
    pricingFingerprint: params.pricingFingerprint,
  });
  const cachedFiles = countUsableUsageCostCacheFiles({
    cache: params.cache,
    files: params.files,
    pricingFingerprint: params.pricingFingerprint,
  });
  const usageEntries: UsageCostCachedUsageEntry[] = [];

  for (const [filePath, entry] of Object.entries(params.cache.files)) {
    const file = filesByPath.get(filePath);
    if (
      !file ||
      !canUseUsageCostCacheEntryForPartial({
        entry,
        file,
        pricingFingerprint: params.pricingFingerprint,
      })
    ) {
      continue;
    }
    for (const usageEntry of entry.usageEntries) {
      usageEntries.push(usageEntry);
    }
  }
  for (const ledgerEntry of params.ledgerEntries ?? []) {
    const usageEntry = cachedUsageEntryFromLedger(ledgerEntry);
    if (!usageEntry) {
      continue;
    }
    usageEntries.push(usageEntry);
  }

  for (const usageEntry of collectCanonicalUsageBridgeEntries(usageEntries)) {
    if (usageEntry.timestamp < params.startMs || usageEntry.timestamp > params.endMs) {
      continue;
    }
    const date = formatDayKey(new Date(usageEntry.timestamp));
    const bucket = dailyMap.get(date) ?? emptyTotals();
    addTotals(bucket, usageEntry);
    dailyMap.set(date, bucket);
    addTotals(totals, usageEntry);
  }

  fillMissingDays(dailyMap, params.startMs, params.endMs);

  const daily = Array.from(dailyMap.entries())
    .map(([date, bucket]) => Object.assign({ date }, bucket))
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const days = Math.ceil((params.endMs - params.startMs) / (24 * 60 * 60 * 1000)) + 1;
  const status = params.refreshing
    ? "refreshing"
    : staleFiles.length > 0
      ? cachedFiles > 0
        ? "partial"
        : "stale"
      : "fresh";

  return {
    updatedAt: Date.now(),
    days,
    daily,
    totals,
    cacheStatus: {
      status,
      cachedFiles,
      pendingFiles: staleFiles.length,
      staleFiles: staleFiles.length,
      refreshedAt: params.cache.updatedAt || undefined,
    },
  };
}

function isSessionSummaryContainedInRange(
  summary: SessionCostSummary,
  startMs: number,
  endMs: number,
): boolean {
  return (
    (summary.firstActivity === undefined || summary.firstActivity >= startMs) &&
    (summary.lastActivity === undefined || summary.lastActivity <= endMs)
  );
}

function buildSessionCostSummaryFromCacheEntry(params: {
  entry: UsageCostCacheFileEntry;
  sessionId?: string;
  sessionFile: string;
  startMs: number;
  endMs: number;
}): SessionCostSummary | null {
  if (!params.entry.transcriptEntries) {
    return null;
  }
  const totals = emptyTotals();
  const activityDatesSet = new Set<string>();
  const dailyMap = new Map<string, { tokens: number; cost: number }>();
  const dailyMessageMap = new Map<string, SessionDailyMessageCounts>();
  const utcQuarterHourMessageMap = new Map<string, SessionUtcQuarterHourMessageCounts>();
  const utcQuarterHourTokenMap = new Map<string, SessionUtcQuarterHourTokenUsage>();
  const dailyLatencyMap = new Map<string, number[]>();
  const dailyModelUsageMap = new Map<string, SessionDailyModelUsage>();
  const messageCounts: SessionMessageCounts = {
    total: 0,
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  };
  const toolUsageMap = new Map<string, number>();
  const modelUsageMap = new Map<string, SessionModelUsage>();
  const errorStopReasons = new Set(["error", "aborted", "timeout"]);
  const latencyValues: number[] = [];
  let firstActivity: number | undefined;
  let lastActivity: number | undefined;
  let lastUserTimestamp: number | undefined;
  const maxLatencyMs = 12 * 60 * 60 * 1000;
  const usageEntries: Array<UsageBridgeComparableEntry & { totals: CostUsageTotals }> = [];

  for (const entry of params.entry.transcriptEntries) {
    const ts = entry.timestamp;
    if (!timestampInReportRange(ts, params.startMs, params.endMs)) {
      if (
        entry.usageTotals &&
        entry.source === "model_call_custom" &&
        timestampInUsageBridgeReconciliationRange(ts, params.startMs, params.endMs)
      ) {
        usageEntries.push({
          source: entry.source,
          ...(entry.usageBudgetOperationId
            ? { usageBudgetOperationId: entry.usageBudgetOperationId }
            : {}),
          timestamp: ts,
          provider: entry.provider,
          model: entry.model,
          input: entry.usageTotals.input,
          output: entry.usageTotals.output,
          cacheRead: entry.usageTotals.cacheRead,
          cacheWrite: entry.usageTotals.cacheWrite,
          totalTokens: entry.usageTotals.totalTokens,
          totals: entry.usageTotals,
        });
      }
      continue;
    }

    if (ts !== undefined) {
      firstActivity = firstActivity === undefined ? ts : Math.min(firstActivity, ts);
      lastActivity = lastActivity === undefined ? ts : Math.max(lastActivity, ts);
    }

    if (entry.role === "user") {
      messageCounts.user += 1;
      messageCounts.total += 1;
      if (ts !== undefined) {
        lastUserTimestamp = ts;
      }
    }
    if (entry.role === "assistant") {
      messageCounts.assistant += 1;
      messageCounts.total += 1;
      if (ts !== undefined) {
        const latencyMs =
          entry.durationMs ??
          (lastUserTimestamp !== undefined ? Math.max(0, ts - lastUserTimestamp) : undefined);
        if (latencyMs !== undefined && Number.isFinite(latencyMs) && latencyMs <= maxLatencyMs) {
          latencyValues.push(latencyMs);
          const dayKey = formatDayKey(new Date(ts));
          const dailyLatencies = dailyLatencyMap.get(dayKey) ?? [];
          dailyLatencies.push(latencyMs);
          dailyLatencyMap.set(dayKey, dailyLatencies);
        }
      }
    }

    if (entry.toolNames.length > 0) {
      messageCounts.toolCalls += entry.toolNames.length;
      for (const name of entry.toolNames) {
        toolUsageMap.set(name, (toolUsageMap.get(name) ?? 0) + 1);
      }
    }

    if (entry.toolResultCounts.total > 0) {
      messageCounts.toolResults += entry.toolResultCounts.total;
      messageCounts.errors += entry.toolResultCounts.errors;
    }

    if (entry.stopReason && errorStopReasons.has(entry.stopReason)) {
      messageCounts.errors += 1;
    }

    if (ts !== undefined) {
      const date = new Date(ts);
      const dayKey = formatDayKey(date);
      activityDatesSet.add(dayKey);
      const daily = dailyMessageMap.get(dayKey) ?? {
        date: dayKey,
        total: 0,
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
      };
      daily.total += entry.role === "user" || entry.role === "assistant" ? 1 : 0;
      if (entry.role === "user") {
        daily.user += 1;
      } else if (entry.role === "assistant") {
        daily.assistant += 1;
      }
      daily.toolCalls += entry.toolNames.length;
      daily.toolResults += entry.toolResultCounts.total;
      daily.errors += entry.toolResultCounts.errors;
      if (entry.stopReason && errorStopReasons.has(entry.stopReason)) {
        daily.errors += 1;
      }
      dailyMessageMap.set(dayKey, daily);

      const quarterBucket = getUtcQuarterHourBucketKey(date);
      const utcQuarterHour = utcQuarterHourMessageMap.get(quarterBucket.key) ?? {
        date: quarterBucket.date,
        quarterIndex: quarterBucket.quarterIndex,
        total: 0,
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
      };
      utcQuarterHour.total += entry.role === "user" || entry.role === "assistant" ? 1 : 0;
      if (entry.role === "user") {
        utcQuarterHour.user += 1;
      } else if (entry.role === "assistant") {
        utcQuarterHour.assistant += 1;
      }
      utcQuarterHour.toolCalls += entry.toolNames.length;
      utcQuarterHour.toolResults += entry.toolResultCounts.total;
      utcQuarterHour.errors += entry.toolResultCounts.errors;
      if (entry.stopReason && errorStopReasons.has(entry.stopReason)) {
        utcQuarterHour.errors += 1;
      }
      utcQuarterHourMessageMap.set(quarterBucket.key, utcQuarterHour);
    }

    const usageTotals = entry.usageTotals;
    if (usageTotals) {
      usageEntries.push({
        source: entry.source,
        ...(entry.usageBudgetOperationId
          ? { usageBudgetOperationId: entry.usageBudgetOperationId }
          : {}),
        timestamp: ts,
        provider: entry.provider,
        model: entry.model,
        input: usageTotals.input,
        output: usageTotals.output,
        cacheRead: usageTotals.cacheRead,
        cacheWrite: usageTotals.cacheWrite,
        totalTokens: usageTotals.totalTokens,
        totals: usageTotals,
      });
    }
  }

  const consumedModelCallBridgeOwnerIndexes = new Set<number>();
  const consumedModelCallBridgeIndexes = new Set<number>();
  for (const [entryIndex, usageEntry] of usageEntries.entries()) {
    if (
      skipModelCallBridgeUsageEntry({
        entry: usageEntry,
        entryIndex,
        entries: usageEntries,
        consumedOwnerIndexes: consumedModelCallBridgeOwnerIndexes,
        consumedBridgeIndexes: consumedModelCallBridgeIndexes,
      })
    ) {
      continue;
    }

    const usageTotals = usageEntry.totals;
    addTotals(totals, usageTotals);
    const ts = usageBridgeTimestampMs(usageEntry);
    if (ts !== undefined) {
      const date = new Date(ts);
      const dayKey = formatDayKey(date);
      const componentTokens =
        usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite;
      const existingDaily = dailyMap.get(dayKey) ?? { tokens: 0, cost: 0 };
      existingDaily.tokens += componentTokens;
      existingDaily.cost += usageTotals.totalCost;
      dailyMap.set(dayKey, existingDaily);

      const quarterBucket = getUtcQuarterHourBucketKey(date);
      const utcQuarterHourToken = utcQuarterHourTokenMap.get(quarterBucket.key) ?? {
        date: quarterBucket.date,
        quarterIndex: quarterBucket.quarterIndex,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        totalCost: 0,
      };
      utcQuarterHourToken.input += usageTotals.input;
      utcQuarterHourToken.output += usageTotals.output;
      utcQuarterHourToken.cacheRead += usageTotals.cacheRead;
      utcQuarterHourToken.cacheWrite += usageTotals.cacheWrite;
      utcQuarterHourToken.totalTokens += usageTotals.totalTokens;
      utcQuarterHourToken.totalCost += usageTotals.totalCost;
      utcQuarterHourTokenMap.set(quarterBucket.key, utcQuarterHourToken);

      if (usageEntry.provider || usageEntry.model) {
        const dailyModelKey = `${dayKey}::${usageEntry.provider ?? "unknown"}::${usageEntry.model ?? "unknown"}`;
        const dailyModel =
          dailyModelUsageMap.get(dailyModelKey) ??
          ({
            date: dayKey,
            provider: usageEntry.provider,
            model: usageEntry.model,
            tokens: 0,
            cost: 0,
            count: 0,
          } as SessionDailyModelUsage);
        dailyModel.tokens += componentTokens;
        dailyModel.cost += usageTotals.totalCost;
        dailyModel.count += 1;
        dailyModelUsageMap.set(dailyModelKey, dailyModel);
      }
    }

    if (usageEntry.provider || usageEntry.model) {
      const modelKey = `${usageEntry.provider ?? "unknown"}::${usageEntry.model ?? "unknown"}`;
      const modelUsage =
        modelUsageMap.get(modelKey) ??
        ({
          provider: usageEntry.provider,
          model: usageEntry.model,
          count: 0,
          totals: emptyTotals(),
        } as SessionModelUsage);
      modelUsage.count += 1;
      addTotals(modelUsage.totals, usageTotals);
      modelUsageMap.set(modelKey, modelUsage);
    }
  }

  const dailyBreakdown: SessionDailyUsage[] = Array.from(dailyMap.entries())
    .map(([date, data]) => ({ date, tokens: data.tokens, cost: data.cost }))
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const dailyMessageCounts: SessionDailyMessageCounts[] = Array.from(
    dailyMessageMap.values(),
  ).toSorted((a, b) => a.date.localeCompare(b.date));
  const utcQuarterHourMessageCounts: SessionUtcQuarterHourMessageCounts[] = Array.from(
    utcQuarterHourMessageMap.values(),
  ).toSorted((a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex);
  const utcQuarterHourTokenUsage = Array.from(utcQuarterHourTokenMap.values()).toSorted(
    (a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex,
  );
  const dailyLatency: SessionDailyLatency[] = Array.from(dailyLatencyMap.entries())
    .map(([date, values]) => {
      const stats = computeLatencyStats(values);
      if (!stats) {
        return null;
      }
      return Object.assign({ date }, stats);
    })
    .filter((entry): entry is SessionDailyLatency => Boolean(entry))
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const dailyModelUsage = Array.from(dailyModelUsageMap.values()).toSorted(
    (a, b) => a.date.localeCompare(b.date) || b.cost - a.cost,
  );
  const toolUsage: SessionToolUsage | undefined = toolUsageMap.size
    ? {
        totalCalls: Array.from(toolUsageMap.values()).reduce((sum, count) => sum + count, 0),
        uniqueTools: toolUsageMap.size,
        tools: Array.from(toolUsageMap.entries())
          .map(([name, count]) => ({ name, count }))
          .toSorted((a, b) => b.count - a.count),
      }
    : undefined;
  const modelUsage = Array.from(modelUsageMap.values()).toSorted((a, b) => {
    const costDiff = (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0);
    if (costDiff !== 0) {
      return costDiff;
    }
    return (b.totals?.totalTokens ?? 0) - (a.totals?.totalTokens ?? 0);
  });

  return {
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    firstActivity,
    lastActivity,
    durationMs:
      firstActivity !== undefined && lastActivity !== undefined
        ? Math.max(0, lastActivity - firstActivity)
        : undefined,
    activityDates: Array.from(activityDatesSet).toSorted(),
    dailyBreakdown,
    dailyMessageCounts,
    utcQuarterHourMessageCounts: utcQuarterHourMessageCounts.length
      ? utcQuarterHourMessageCounts
      : undefined,
    utcQuarterHourTokenUsage: utcQuarterHourTokenUsage.length
      ? utcQuarterHourTokenUsage
      : undefined,
    dailyLatency: dailyLatency.length ? dailyLatency : undefined,
    dailyModelUsage: dailyModelUsage.length ? dailyModelUsage : undefined,
    messageCounts,
    toolUsage,
    modelUsage: modelUsage.length ? modelUsage : undefined,
    latency: computeLatencyStats(latencyValues),
    ...totals,
  };
}

const extractCostBreakdown = (usageRaw?: UsageLike | null): CostBreakdown | undefined => {
  if (!usageRaw || typeof usageRaw !== "object") {
    return undefined;
  }
  const record = usageRaw as Record<string, unknown>;
  const cost = record.cost as Record<string, unknown> | undefined;
  if (!cost) {
    return undefined;
  }

  const total = asFiniteNumber(cost.total);
  if (total === undefined || total < 0) {
    return undefined;
  }

  return {
    total,
    input: asFiniteNumber(cost.input),
    output: asFiniteNumber(cost.output),
    cacheRead: asFiniteNumber(cost.cacheRead),
    cacheWrite: asFiniteNumber(cost.cacheWrite),
  };
};

const parseTimestamp = (
  entry: Record<string, unknown>,
  resolvedMessage?: Record<string, unknown>,
): Date | undefined => {
  const raw = entry.timestamp;
  if (typeof raw === "string") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed;
    }
  }
  const message = resolvedMessage ?? (entry.message as Record<string, unknown> | undefined);
  const messageTimestamp = asFiniteNumber(message?.timestamp);
  if (messageTimestamp !== undefined) {
    const parsed = new Date(messageTimestamp);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed;
    }
  }
  return undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompactionUsageAccountingEntry(entry: Record<string, unknown>): boolean {
  return entry.type === "custom" && entry.customType === COMPACTION_USAGE_ACCOUNTING_CUSTOM_TYPE;
}

function isModelCallUsageAccountingEntry(entry: Record<string, unknown>): boolean {
  return entry.type === "custom" && entry.customType === MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE;
}

function isModelCallUsageBudgetBridgeEntry(entry: Record<string, unknown>): boolean {
  if (!isModelCallUsageAccountingEntry(entry)) {
    return false;
  }
  const data = isRecord(entry.data) ? entry.data : undefined;
  return data?.usageBudgetBridge === true;
}

function resolveUsageAccountingSource(entry: Record<string, unknown>): UsageAccountingSource {
  if (entry.type === "compaction") {
    return "compaction";
  }
  if (entry.type === "branch_summary") {
    return "branch_summary";
  }
  if (isModelCallUsageBudgetBridgeEntry(entry)) {
    return "model_call_custom";
  }
  if (isCompactionUsageAccountingEntry(entry)) {
    return "compaction_custom";
  }
  return "message";
}

function resolveCompactionUsageAccounting(
  entry: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    (entry.type !== "compaction" && entry.type !== "branch_summary") ||
    !isRecord(entry.usageAccounting)
  ) {
    return undefined;
  }
  return entry.usageAccounting;
}

function resolveUsageBudgetOperationId(entry: Record<string, unknown>): string | undefined {
  const message = isRecord(entry.message) ? entry.message : undefined;
  const messageId = message?.[USAGE_BUDGET_OPERATION_ID_KEY];
  if (typeof messageId === "string" && messageId.trim()) {
    return messageId;
  }
  const usageAccounting = resolveCompactionUsageAccounting(entry);
  const usageAccountingId = usageAccounting?.[USAGE_BUDGET_OPERATION_ID_KEY];
  if (typeof usageAccountingId === "string" && usageAccountingId.trim()) {
    return usageAccountingId;
  }
  const data = isRecord(entry.data) ? entry.data : undefined;
  const dataId = data?.[USAGE_BUDGET_OPERATION_ID_KEY];
  if (typeof dataId === "string" && dataId.trim()) {
    return dataId;
  }
  const directId = entry[USAGE_BUDGET_OPERATION_ID_KEY];
  return typeof directId === "string" && directId.trim() ? directId : undefined;
}

function resolveTranscriptEntryMessage(
  entry: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (isRecord(entry.message)) {
    return entry.message;
  }
  const compactionAccounting = resolveCompactionUsageAccounting(entry);
  if (compactionAccounting) {
    return {
      role: "assistant",
      content: [],
      api: compactionAccounting.api,
      provider: compactionAccounting.provider,
      model: compactionAccounting.model,
      usage: compactionAccounting.usage,
      stopReason: "stop",
      timestamp: entry.timestamp,
    };
  }
  if (!isCompactionUsageAccountingEntry(entry) && !isModelCallUsageAccountingEntry(entry)) {
    return undefined;
  }
  const data = isRecord(entry.data) ? entry.data : undefined;
  return isRecord(data?.message) ? data.message : undefined;
}

const parseTranscriptEntry = (entry: Record<string, unknown>): ParsedTranscriptEntry | null => {
  const message = resolveTranscriptEntryMessage(entry);
  if (!message) {
    return null;
  }

  const roleRaw = message.role;
  const parsedRole = roleRaw === "user" || roleRaw === "assistant" ? roleRaw : undefined;
  const usageOnly =
    isCompactionUsageAccountingEntry(entry) ||
    isModelCallUsageAccountingEntry(entry) ||
    resolveCompactionUsageAccounting(entry) !== undefined;
  const role = usageOnly ? undefined : parsedRole;
  if (!role && !usageOnly) {
    return null;
  }

  const usageRaw =
    (message.usage as UsageLike | undefined) ?? (entry.usage as UsageLike | undefined);
  const usage = usageRaw ? (normalizeUsage(usageRaw) ?? undefined) : undefined;

  const provider =
    (typeof message.provider === "string" ? message.provider : undefined) ??
    (typeof entry.provider === "string" ? entry.provider : undefined);
  const model =
    (typeof message.model === "string" ? message.model : undefined) ??
    (typeof entry.model === "string" ? entry.model : undefined);

  const costBreakdown = extractCostBreakdown(usageRaw);
  const usageBudgetRecordedCostTotal = readUsageBudgetRecordedCostTotal(usageRaw);
  const usageBudgetUnpriceableCost = hasUsageBudgetUnpriceableCostMetadata(usageRaw);
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  const durationMs = asFiniteNumber(message.durationMs ?? entry.durationMs);
  const entryId = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined;
  const usageBudgetOperationId = resolveUsageBudgetOperationId(entry);

  return {
    entryId,
    source: resolveUsageAccountingSource(entry),
    ...(usageBudgetOperationId ? { usageBudgetOperationId } : {}),
    message,
    role,
    timestamp: parseTimestamp(entry, message),
    durationMs,
    usage,
    costTotal: costBreakdown?.total,
    costBreakdown,
    usageBudgetRecordedCostTotal,
    usageBudgetUnpriceableCost,
    provider,
    model,
    stopReason,
    toolNames: extractToolCallNames(message),
    toolResultCounts: countToolResults(message),
  };
};

const formatDayKey = (date: Date): string =>
  date.toLocaleDateString("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });

function buildLegacyParsedUsageRecordId(entry: ParsedTranscriptEntry): string | undefined {
  if (entry.entryId) {
    return undefined;
  }
  if (entry.legacyRowFingerprint === undefined || entry.legacyRowOccurrenceIndex === undefined) {
    return undefined;
  }
  const timestampMs = entry.timestamp?.getTime();
  if (timestampMs === undefined) {
    return undefined;
  }
  return [
    "legacy-transcript",
    entry.legacyRowFingerprint,
    entry.legacyRowOccurrenceIndex,
    timestampMs,
    entry.provider ?? "",
    entry.model ?? "",
  ].join("|");
}

function buildStableLegacyParsedRowFingerprint(params: {
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

function resolveUsageCostTranscriptIdentitySessionId(params: {
  filePath: string;
  fallbackSessionId: string;
  header: Record<string, unknown>;
}): string {
  const usageFamilyKey = resolveUsageCostTranscriptUsageFamilyKey({
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

const USAGE_COST_TRANSCRIPT_HEADER_READ_BYTES = 64 * 1024;

function readUsageCostTranscriptHeader(filePath: string): Record<string, unknown> | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(USAGE_COST_TRANSCRIPT_HEADER_READ_BYTES);
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

function resolveUsageCostTranscriptUsageFamilyKey(params: {
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
        const parentHeader = readUsageCostTranscriptHeader(parentPath);
        if (!parentHeader) {
          return undefined;
        }
        return resolveUsageCostTranscriptUsageFamilyKey({
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

function buildParsedUsageDedupKey(entry: ParsedTranscriptEntry): string | undefined {
  if (!entry.usage) {
    return undefined;
  }
  if (entry.entryId) {
    return ["transcript-entry", entry.sessionId ?? "", entry.entryId].join("|");
  }
  return buildLegacyParsedUsageRecordId(entry);
}

function parsedUsageEntryFromLedger(
  entry: UsageBudgetLedgerAccountedEntry,
): ParsedUsageEntry | undefined {
  if (!entry.usage) {
    return undefined;
  }
  return {
    ...(entry.sourceFilePath ? { sourceFilePath: entry.sourceFilePath } : {}),
    ...(entry.sourceLineIndex !== undefined ? { sourceLineIndex: entry.sourceLineIndex } : {}),
    ...(entry.recordId ? { entryId: entry.recordId } : {}),
    dedupKey: entry.dedupKey,
    source: entry.source,
    ...(entry.usageBudgetOperationId
      ? { usageBudgetOperationId: entry.usageBudgetOperationId }
      : {}),
    usage: entry.usage,
    costTotal: entry.missingCostEntries > 0 ? undefined : entry.totalCost,
    provider: entry.provider,
    model: entry.model,
    timestamp: new Date(entry.timestampMs),
  };
}

function cachedUsageEntryFromLedger(
  entry: UsageBudgetLedgerAccountedEntry,
): UsageCostCachedUsageEntry | undefined {
  if (!entry.usage) {
    return undefined;
  }
  const totals = emptyTotals();
  totals.input = entry.usage.input ?? 0;
  totals.output = entry.usage.output ?? 0;
  totals.cacheRead = entry.usage.cacheRead ?? 0;
  totals.cacheWrite = entry.usage.cacheWrite ?? 0;
  totals.totalTokens = entry.totalTokens;
  totals.totalCost = entry.missingCostEntries > 0 ? 0 : entry.totalCost;
  totals.missingCostEntries = entry.missingCostEntries;
  return {
    ...(entry.recordId ? { entryId: entry.recordId } : {}),
    ...(entry.dedupKey ? { dedupKey: entry.dedupKey } : {}),
    ...(entry.sourceFilePath ? { sourceFilePath: entry.sourceFilePath } : {}),
    ...(entry.sourceLineIndex !== undefined ? { sourceLineIndex: entry.sourceLineIndex } : {}),
    source: entry.source,
    ...(entry.usageBudgetOperationId
      ? { usageBudgetOperationId: entry.usageBudgetOperationId }
      : {}),
    timestamp: entry.timestampMs,
    provider: entry.provider,
    model: entry.model,
    ...totals,
  };
}

type UsageBridgeComparableEntry = {
  entryId?: string;
  dedupKey?: string;
  sourceFilePath?: string;
  sourceLineIndex?: number;
  source?: UsageAccountingSource;
  usageBudgetOperationId?: string;
  timestamp?: number | Date;
  provider?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  usage?: NormalizedUsage;
  costTotal?: number;
  costBreakdown?: CostBreakdown;
  totalCost?: number;
  totals?: CostUsageTotals;
  missingCostEntries?: number;
  usageBudgetRecordedCostTotal?: number;
};

const MODEL_CALL_BRIDGE_MATCH_WINDOW_MS = 5 * 60 * 1000;
const USAGE_COST_BRIDGE_RECONCILIATION_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function timestampInReportRange(
  timestampMs: number | undefined,
  startMs: number | undefined,
  endMs: number | undefined,
): boolean {
  if (startMs !== undefined && timestampMs !== undefined && timestampMs < startMs) {
    return false;
  }
  if (endMs !== undefined && timestampMs !== undefined && timestampMs > endMs) {
    return false;
  }
  return true;
}

function timestampInUsageBridgeReconciliationRange(
  timestampMs: number | undefined,
  startMs: number | undefined,
  endMs: number | undefined,
): boolean {
  if (timestampMs === undefined) {
    return true;
  }
  if (endMs !== undefined && timestampMs > endMs) {
    return false;
  }
  return (
    startMs === undefined || timestampMs >= startMs - USAGE_COST_BRIDGE_RECONCILIATION_LOOKBACK_MS
  );
}

function isAggregateUsageBridgeOwner(entry: UsageBridgeComparableEntry): boolean {
  return (
    entry.source === "compaction" ||
    entry.source === "branch_summary" ||
    entry.source === "compaction_custom"
  );
}

function usageBridgeTimestampMs(entry: UsageBridgeComparableEntry): number | undefined {
  if (entry.timestamp instanceof Date) {
    return entry.timestamp.getTime();
  }
  return typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
    ? entry.timestamp
    : undefined;
}

function usageBridgeComponentValue(
  entry: UsageBridgeComparableEntry,
  key: "input" | "output" | "cacheRead" | "cacheWrite",
): number {
  return entry.usage?.[key] ?? entry[key] ?? 0;
}

function usageBridgeTotalTokens(entry: UsageBridgeComparableEntry): number {
  return (
    entry.usage?.total ??
    entry.totalTokens ??
    usageBridgeComponentValue(entry, "input") +
      usageBridgeComponentValue(entry, "output") +
      usageBridgeComponentValue(entry, "cacheRead") +
      usageBridgeComponentValue(entry, "cacheWrite")
  );
}

type UsageBridgeComponents = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

function usageBridgeComponents(entry: UsageBridgeComparableEntry): UsageBridgeComponents {
  return {
    input: usageBridgeComponentValue(entry, "input"),
    output: usageBridgeComponentValue(entry, "output"),
    cacheRead: usageBridgeComponentValue(entry, "cacheRead"),
    cacheWrite: usageBridgeComponentValue(entry, "cacheWrite"),
    total: usageBridgeTotalTokens(entry),
  };
}

function addUsageBridgeComponents(
  left: UsageBridgeComponents,
  right: UsageBridgeComponents,
): UsageBridgeComponents {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    total: left.total + right.total,
  };
}

function usageBridgeComponentsEqual(
  left: UsageBridgeComponents,
  right: UsageBridgeComponents,
): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.total === right.total
  );
}

function usageBridgeComponentsExceed(
  left: UsageBridgeComponents,
  right: UsageBridgeComponents,
): boolean {
  return (
    left.input > right.input ||
    left.output > right.output ||
    left.cacheRead > right.cacheRead ||
    left.cacheWrite > right.cacheWrite ||
    left.total > right.total
  );
}

function usageBridgeSignature(entry: UsageBridgeComparableEntry): string {
  return [
    entry.provider ?? "",
    entry.model ?? "",
    usageBridgeComponentValue(entry, "input"),
    usageBridgeComponentValue(entry, "output"),
    usageBridgeComponentValue(entry, "cacheRead"),
    usageBridgeComponentValue(entry, "cacheWrite"),
    usageBridgeTotalTokens(entry),
  ].join("|");
}

function usageBridgeCanBelongToOwner(
  bridge: UsageBridgeComparableEntry,
  owner: UsageBridgeComparableEntry,
): boolean {
  if (bridge.source !== "model_call_custom" || owner.source === "model_call_custom") {
    return false;
  }
  const sameProviderModel = bridge.provider === owner.provider && bridge.model === owner.model;
  const sameOperationId =
    bridge.usageBudgetOperationId !== undefined &&
    bridge.usageBudgetOperationId === owner.usageBudgetOperationId;
  if (isAggregateUsageBridgeOwner(owner)) {
    if (bridge.usageBudgetOperationId || owner.usageBudgetOperationId) {
      return sameOperationId;
    }
  }
  if (bridge.usageBudgetOperationId || owner.usageBudgetOperationId) {
    return sameProviderModel && sameOperationId;
  }
  if (!sameProviderModel) {
    return false;
  }
  const bridgeTimestamp = usageBridgeTimestampMs(bridge);
  const ownerTimestamp = usageBridgeTimestampMs(owner);
  return (
    bridgeTimestamp !== undefined &&
    ownerTimestamp !== undefined &&
    Math.abs(bridgeTimestamp - ownerTimestamp) <= MODEL_CALL_BRIDGE_MATCH_WINDOW_MS
  );
}

function modelCallBridgeMatchesCanonicalUsage(
  bridge: UsageBridgeComparableEntry,
  owner: UsageBridgeComparableEntry,
): boolean {
  return (
    usageBridgeCanBelongToOwner(bridge, owner) &&
    usageBridgeSignature(bridge) === usageBridgeSignature(owner)
  );
}

function usageBridgeKnownCostTotal(entry: UsageBridgeComparableEntry): number | undefined {
  const total =
    entry.usageBudgetRecordedCostTotal ??
    entry.costBreakdown?.total ??
    entry.costTotal ??
    entry.totalCost ??
    entry.totals?.totalCost;
  if (total === undefined || !Number.isFinite(total)) {
    return undefined;
  }
  if ((entry.missingCostEntries ?? entry.totals?.missingCostEntries ?? 0) > 0) {
    return undefined;
  }
  return total;
}

function applyUsageBridgeReconciledCost(
  entry: UsageBridgeComparableEntry,
  totalCost: number,
): void {
  entry.costTotal = totalCost;
  entry.costBreakdown = undefined;
  entry.totalCost = totalCost;
  entry.missingCostEntries = 0;
  if (entry.totals) {
    entry.totals.totalCost = totalCost;
    entry.totals.inputCost = 0;
    entry.totals.outputCost = 0;
    entry.totals.cacheReadCost = 0;
    entry.totals.cacheWriteCost = 0;
    entry.totals.missingCostEntries = 0;
  }
}

function reconcileAggregateUsageBridgeOwnerCost<TEntry extends UsageBridgeComparableEntry>(
  owner: TEntry,
  bridges: readonly TEntry[],
): void {
  if (!isAggregateUsageBridgeOwner(owner)) {
    return;
  }
  const target = usageBridgeComponents(owner);
  let covered = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let totalCost = 0;
  for (const bridge of bridges) {
    covered = addUsageBridgeComponents(covered, usageBridgeComponents(bridge));
    const bridgeCost = usageBridgeKnownCostTotal(bridge);
    if (bridgeCost === undefined) {
      return;
    }
    totalCost += bridgeCost;
  }
  if (!usageBridgeComponentsEqual(covered, target)) {
    return;
  }
  applyUsageBridgeReconciledCost(owner, totalCost);
}

function findUsageBridgeSubsetForOwner<TEntry extends UsageBridgeComparableEntry>(params: {
  entry: TEntry;
  entryIndex: number;
  owner: TEntry;
  entries: readonly TEntry[];
  consumedBridgeIndexes: Set<number>;
}): number[] | undefined {
  if (!usageBridgeCanBelongToOwner(params.entry, params.owner)) {
    return undefined;
  }
  const target = usageBridgeComponents(params.owner);
  const current = usageBridgeComponents(params.entry);
  if (usageBridgeComponentsExceed(current, target)) {
    return undefined;
  }
  const ownerTimestamp = usageBridgeTimestampMs(params.owner) ?? 0;
  const candidates = [
    { candidate: params.entry, index: params.entryIndex },
    ...params.entries
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate, index }) => {
        return (
          index !== params.entryIndex &&
          !params.consumedBridgeIndexes.has(index) &&
          usageBridgeCanBelongToOwner(candidate, params.owner)
        );
      }),
  ].toSorted((a, b) => {
    const aTimestamp = usageBridgeTimestampMs(a.candidate) ?? ownerTimestamp;
    const bTimestamp = usageBridgeTimestampMs(b.candidate) ?? ownerTimestamp;
    return Math.abs(aTimestamp - ownerTimestamp) - Math.abs(bTimestamp - ownerTimestamp);
  });
  const total = candidates.reduce<UsageBridgeComponents>(
    (sum, candidate) => addUsageBridgeComponents(sum, usageBridgeComponents(candidate.candidate)),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );
  if (usageBridgeComponentsEqual(total, target)) {
    return candidates.map((candidate) => candidate.index);
  }
  if (
    params.owner.usageBudgetOperationId &&
    !usageBridgeComponentsExceed(total, target) &&
    candidates.every(
      ({ candidate }) => candidate.usageBudgetOperationId === params.owner.usageBudgetOperationId,
    )
  ) {
    return candidates.map((candidate) => candidate.index);
  }
  return undefined;
}

function skipModelCallBridgeUsageEntry<TEntry extends UsageBridgeComparableEntry>(params: {
  entry: TEntry;
  entryIndex: number;
  entries: readonly TEntry[];
  consumedOwnerIndexes: Set<number>;
  consumedBridgeIndexes: Set<number>;
}): boolean {
  if (params.consumedBridgeIndexes.has(params.entryIndex)) {
    return true;
  }
  if (params.entry.source !== "model_call_custom") {
    return false;
  }
  const ownerIndex = params.entries.findIndex((owner, candidateIndex) => {
    return (
      candidateIndex !== params.entryIndex &&
      !params.consumedOwnerIndexes.has(candidateIndex) &&
      modelCallBridgeMatchesCanonicalUsage(params.entry, owner)
    );
  });
  if (ownerIndex === -1) {
    const aggregateOwner = params.entries
      .map((owner, index) => ({ owner, index }))
      .find(({ owner, index }) => {
        if (index === params.entryIndex || params.consumedOwnerIndexes.has(index)) {
          return false;
        }
        const subset = findUsageBridgeSubsetForOwner({
          entry: params.entry,
          entryIndex: params.entryIndex,
          owner,
          entries: params.entries,
          consumedBridgeIndexes: params.consumedBridgeIndexes,
        });
        if (!subset) {
          return false;
        }
        reconcileAggregateUsageBridgeOwnerCost(
          owner,
          subset.map((bridgeIndex) => params.entries[bridgeIndex]).filter(Boolean),
        );
        params.consumedOwnerIndexes.add(index);
        for (const bridgeIndex of subset) {
          params.consumedBridgeIndexes.add(bridgeIndex);
        }
        return true;
      });
    return Boolean(aggregateOwner);
  }
  reconcileAggregateUsageBridgeOwnerCost(params.entries[ownerIndex], [params.entry]);
  params.consumedOwnerIndexes.add(ownerIndex);
  params.consumedBridgeIndexes.add(params.entryIndex);
  return true;
}

function usageCostEntrySourceRank(entry: UsageBridgeComparableEntry): number {
  const filePath = entry.sourceFilePath;
  if (!filePath) {
    return 2;
  }
  return isPrimarySessionTranscriptFileName(path.basename(filePath)) ? 0 : 1;
}

function usageCostEntryArchiveTimestamp(filePath?: string): number {
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

function compareDuplicateUsageCostEntries<TEntry extends UsageBridgeComparableEntry>(
  left: TEntry,
  right: TEntry,
): number {
  const sourceRankDelta = usageCostEntrySourceRank(left) - usageCostEntrySourceRank(right);
  if (sourceRankDelta !== 0) {
    return sourceRankDelta;
  }
  const archiveDelta =
    usageCostEntryArchiveTimestamp(right.sourceFilePath) -
    usageCostEntryArchiveTimestamp(left.sourceFilePath);
  if (archiveDelta !== 0) {
    return archiveDelta;
  }
  const missingCostDelta = (left.missingCostEntries ?? 0) - (right.missingCostEntries ?? 0);
  if (missingCostDelta !== 0) {
    return missingCostDelta;
  }
  const timestampDelta =
    (usageBridgeTimestampMs(right) ?? Number.NEGATIVE_INFINITY) -
    (usageBridgeTimestampMs(left) ?? Number.NEGATIVE_INFINITY);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  return stableStringify(left).localeCompare(stableStringify(right));
}

function parseTranscriptEntryDedupKey(
  dedupKey: string | undefined,
): { sessionId: string; entryId: string } | undefined {
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

function usageCostEntryIdDuplicateKey(entry: UsageBridgeComparableEntry): string | undefined {
  if (!entry.entryId) {
    return undefined;
  }
  const parsed = parseTranscriptEntryDedupKey(entry.dedupKey);
  const sameEntryId =
    parsed?.entryId === entry.entryId || parsed?.entryId.startsWith(`${entry.entryId}|`);
  if (!parsed || !sameEntryId || parsed.sessionId.length === 0) {
    return undefined;
  }
  return ["transcript-entry", parsed.sessionId, entry.entryId].join("|");
}

function collapseLedgerTranscriptEntryIdDuplicates<TEntry extends UsageBridgeComparableEntry>(
  entries: readonly TEntry[],
): TEntry[] {
  const byEntryId = new Map<string, TEntry[]>();
  for (const entry of entries) {
    if (!entry.entryId) {
      continue;
    }
    const group = byEntryId.get(entry.entryId) ?? [];
    group.push(entry);
    byEntryId.set(entry.entryId, group);
  }
  const consumed = new Set<TEntry>();
  const collapsed: TEntry[] = [];
  const collapseGroup = (group: TEntry[]): void => {
    if (
      group.length > 1 &&
      group.some((entry) => entry.sourceFilePath) &&
      group.some((entry) => !entry.sourceFilePath)
    ) {
      const canonical = group.toSorted(compareDuplicateUsageCostEntries)[0];
      if (canonical) {
        collapsed.push(canonical);
      }
      for (const entry of group) {
        consumed.add(entry);
      }
    }
  };
  for (const group of byEntryId.values()) {
    const byScopedEntryId = new Map<string, TEntry[]>();
    for (const entry of group) {
      const key = usageCostEntryIdDuplicateKey(entry);
      if (!key) {
        continue;
      }
      const scopedGroup = byScopedEntryId.get(key) ?? [];
      scopedGroup.push(entry);
      byScopedEntryId.set(key, scopedGroup);
    }
    for (const scopedGroup of byScopedEntryId.values()) {
      collapseGroup(scopedGroup);
    }
    const remaining = group.filter((entry) => !consumed.has(entry));
    const remainingScopedKeys = new Set(
      remaining.flatMap((entry) => {
        const key = usageCostEntryIdDuplicateKey(entry);
        return key ? [key] : [];
      }),
    );
    if (remainingScopedKeys.size <= 1) {
      collapseGroup(remaining);
    }
  }
  for (const entry of entries) {
    if (!consumed.has(entry)) {
      collapsed.push(entry);
    }
  }
  return collapsed;
}

function deduplicateUsageCostEntries<TEntry extends UsageBridgeComparableEntry>(
  entries: readonly TEntry[],
): TEntry[] {
  const passthrough: TEntry[] = [];
  const byDedupKey = new Map<string, TEntry>();
  for (const entry of entries) {
    if (!entry.dedupKey) {
      passthrough.push(entry);
      continue;
    }
    const existing = byDedupKey.get(entry.dedupKey);
    if (!existing || compareDuplicateUsageCostEntries(entry, existing) < 0) {
      byDedupKey.set(entry.dedupKey, entry);
    }
  }
  return collapseLedgerTranscriptEntryIdDuplicates([...passthrough, ...byDedupKey.values()]);
}

function collectCanonicalUsageBridgeEntries<TEntry extends UsageBridgeComparableEntry>(
  entries: readonly TEntry[],
): TEntry[] {
  const canonicalInputEntries = deduplicateUsageCostEntries(entries);
  const consumedModelCallBridgeOwnerIndexes = new Set<number>();
  const consumedModelCallBridgeIndexes = new Set<number>();
  const canonicalEntries: TEntry[] = [];
  for (const [entryIndex, entry] of canonicalInputEntries.entries()) {
    if (
      skipModelCallBridgeUsageEntry({
        entry,
        entryIndex,
        entries: canonicalInputEntries,
        consumedOwnerIndexes: consumedModelCallBridgeOwnerIndexes,
        consumedBridgeIndexes: consumedModelCallBridgeIndexes,
      })
    ) {
      continue;
    }
    canonicalEntries.push(entry);
  }
  return canonicalEntries;
}

/**
 * Maximum window (in days) for which we will zero-fill missing calendar
 * days. Bounded ranges from the UI's range filter top out at 90 days for
 * the explicit picker and "All" is the wildcard escape hatch — anything
 * wider than this threshold is treated as an all-time / open-ended range
 * and falls back to sparse behavior (only days with activity), since a
 * dense series at that scale would produce tens of thousands of zero
 * buckets (e.g. a 1970-based startMs → ~20k entries) without any user
 * value. 366 days covers a full year + leap-day cushion.
 */
const MAX_ZERO_FILL_DAYS = 366;

/**
 * Parse a `YYYY-MM-DD` day key (as produced by `formatDayKey`) into a Date
 * constructed at local noon on that calendar date. Local-noon anchoring
 * gives a ±12h cushion so the resulting Date always formats back to the
 * same key via `formatDayKey`, even across DST transitions where the
 * local clock shifts by ±1h. Returns `null` for malformed keys so the
 * caller can fall back safely.
 */
const parseDayKeyToLocalNoon = (dayKey: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const monthIdx = Number(match[2]) - 1;
  const day = Number(match[3]);
  // Constructs the Date in the runtime's local timezone, which is the same
  // timezone `formatDayKey` uses (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
  const date = new Date(year, monthIdx, day, 12, 0, 0, 0);
  return Number.isFinite(date.getTime()) ? date : null;
};

/**
 * Ensure the daily map has an entry for every calendar day in [startMs, endMs].
 * Days without activity are inserted with a zero-valued totals bucket so the
 * resulting `daily` series matches the requested range length (one bar per
 * calendar day) instead of only covering days with recorded usage.
 *
 * Iteration steps by calendar day in the local timezone — we derive the
 * start and end day keys via `formatDayKey`, anchor a cursor at local noon
 * of the start day, and advance via `setDate(getDate() + 1)`. This is
 * robust against local-clock DST transitions where a fixed 24h ms step
 * would land in the previous or next calendar day (and risk skipping an
 * interior day from the zero-fill output).
 */
const fillMissingDays = (
  dailyMap: Map<string, CostUsageTotals>,
  startMs: number,
  endMs: number,
): void => {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  // Bound the fill so unbounded / all-time ranges don't generate tens of
  // thousands of zero buckets. Wider ranges keep their existing sparse
  // (activity-only) shape.
  const spanDays = Math.floor((endMs - startMs) / dayMs) + 1;
  if (spanDays > MAX_ZERO_FILL_DAYS) {
    return;
  }
  const startKey = formatDayKey(new Date(startMs));
  const endKey = formatDayKey(new Date(endMs));
  const cursorDate = parseDayKeyToLocalNoon(startKey);
  if (cursorDate === null) {
    // Defensive fallback — formatDayKey should always produce a YYYY-MM-DD
    // key, but if locale data ever shifts under us, at least make sure the
    // endpoint days are present so the chart isn't completely empty.
    if (!dailyMap.has(startKey)) {
      dailyMap.set(startKey, emptyTotals());
    }
    if (!dailyMap.has(endKey)) {
      dailyMap.set(endKey, emptyTotals());
    }
    return;
  }
  // Hard upper bound to avoid runaway loops on bogus inputs (e.g. malformed
  // formatDayKey output that never reaches endKey). Pads the expected span
  // by a few iterations to cover any DST-driven boundary fuzz.
  const maxIterations = MAX_ZERO_FILL_DAYS + 5;
  let lastKey: string | undefined;
  for (let i = 0; i <= maxIterations; i += 1) {
    const key = formatDayKey(cursorDate);
    if (!dailyMap.has(key)) {
      dailyMap.set(key, emptyTotals());
    }
    lastKey = key;
    if (key === endKey) {
      break;
    }
    // Advance one calendar day in the local timezone. `setDate` handles
    // month/year rollover, and the local-noon anchor (set in
    // parseDayKeyToLocalNoon) gives us a ±12h cushion against ±1h DST
    // shifts, so the cursor never lands in the prior or next calendar day.
    cursorDate.setDate(cursorDate.getDate() + 1);
  }
  // Defensive: make sure the end-day key is present even if the loop
  // terminated early (e.g. iteration cap hit before reaching endKey).
  if (lastKey !== endKey && !dailyMap.has(endKey)) {
    dailyMap.set(endKey, emptyTotals());
  }
};

const formatUtcDayKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const getUtcQuarterHourBucketKey = (
  date: Date,
): { date: string; quarterIndex: number; key: string } => {
  const quarterIndex = Math.floor((date.getUTCHours() * 60 + date.getUTCMinutes()) / 15);
  const utcDayKey = formatUtcDayKey(date);
  return { date: utcDayKey, quarterIndex, key: `${utcDayKey}::${quarterIndex}` };
};

/**
 * Accumulate message-level counts into a bucket (daily or UTC quarter-hour).
 * Avoids duplicating the same logic for both daily and quarter-hour message counts.
 */
const accumulateMessageCounts = (
  bucket: {
    total: number;
    user: number;
    assistant: number;
    toolCalls: number;
    toolResults: number;
    errors: number;
  },
  entry: ParsedTranscriptEntry,
  errorStopReasons: Set<string>,
) => {
  bucket.total += entry.role === "user" || entry.role === "assistant" ? 1 : 0;
  if (entry.role === "user") {
    bucket.user += 1;
  } else if (entry.role === "assistant") {
    bucket.assistant += 1;
  }
  bucket.toolCalls += entry.toolNames.length;
  bucket.toolResults += entry.toolResultCounts.total;
  bucket.errors += entry.toolResultCounts.errors;
  if (entry.stopReason && errorStopReasons.has(entry.stopReason)) {
    bucket.errors += 1;
  }
};

const computeLatencyStats = (values: number[]): SessionLatencyStats | undefined => {
  if (!values.length) {
    return undefined;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  const count = sorted.length;
  const p95Index = Math.max(0, Math.ceil(count * 0.95) - 1);
  return {
    count,
    avgMs: total / count,
    p95Ms: sorted[p95Index] ?? sorted[count - 1],
    minMs: sorted[0],
    maxMs: sorted[count - 1],
  };
};

const computeUsageTokenTotals = (usage: NormalizedUsage) => {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const componentTotal = input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    componentTotal,
    totalTokens: usage.total ?? componentTotal,
  };
};

const applyUsageTotals = (totals: CostUsageTotals, usage: NormalizedUsage) => {
  const usageTotals = computeUsageTokenTotals(usage);
  totals.input += usageTotals.input;
  totals.output += usageTotals.output;
  totals.cacheRead += usageTotals.cacheRead;
  totals.cacheWrite += usageTotals.cacheWrite;
  totals.totalTokens += usageTotals.totalTokens;
};

const applyCostBreakdown = (totals: CostUsageTotals, costBreakdown: CostBreakdown | undefined) => {
  if (costBreakdown === undefined || costBreakdown.total === undefined) {
    return;
  }
  totals.totalCost += costBreakdown.total;
  totals.inputCost += costBreakdown.input ?? 0;
  totals.outputCost += costBreakdown.output ?? 0;
  totals.cacheReadCost += costBreakdown.cacheRead ?? 0;
  totals.cacheWriteCost += costBreakdown.cacheWrite ?? 0;
};

// Legacy function for backwards compatibility (no cost breakdown available)
const applyCostTotal = (totals: CostUsageTotals, costTotal: number | undefined) => {
  if (costTotal === undefined) {
    totals.missingCostEntries += 1;
    return;
  }
  totals.totalCost += costTotal;
};

// A resolved cost config only counts as "known" pricing when it carries at least one
// positive per-token rate (or tiered pricing). An all-zero config is indistinguishable
// from "pricing unknown": e.g. codex models ship cost {input:0,output:0,...} in the
// generated models.json because the Codex backend exposes no per-token price. Treating
// such a config as a real $0 makes usage-cost report confident zero spend, which
// silently blinds every budget/spike safeguard that keys off totalCost.
const isModelPricingKnown = (cost: ReturnType<typeof resolveModelCostConfig>): boolean => {
  if (!cost) {
    return false;
  }
  if (cost.tieredPricing && cost.tieredPricing.length > 0) {
    return true;
  }
  return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
};

const shouldPreserveRecordedZeroCost = (costBreakdown: CostBreakdown | undefined): boolean =>
  costBreakdown?.total === 0 &&
  [
    costBreakdown.input,
    costBreakdown.output,
    costBreakdown.cacheRead,
    costBreakdown.cacheWrite,
  ].some((value) => value !== undefined && value !== 0);

const shouldRecomputeRecordedZeroCost = (params: {
  cost: ReturnType<typeof resolveModelCostConfig>;
  costBreakdown: CostBreakdown | undefined;
  costTotal: number | undefined;
  usage: NormalizedUsage;
}): boolean =>
  params.costTotal === 0 &&
  !shouldPreserveRecordedZeroCost(params.costBreakdown) &&
  isModelPricingKnown(params.cost) &&
  computeUsageTokenTotals(params.usage).totalTokens > 0;

function estimateUsageCostWithRecordedMultiplier(params: {
  usage: NormalizedUsage;
  usageRaw: unknown;
  cost: ReturnType<typeof resolveModelCostConfig>;
}): number | undefined {
  const estimated = estimateUsageCost({ usage: params.usage, cost: params.cost });
  if (estimated === undefined) {
    return undefined;
  }
  const metadata = readUsageBudgetRecordedCostMetadata(params.usageRaw);
  return metadata?.authoritativeCost === false ? estimated * metadata.costMultiplier : estimated;
}

type UsageCostResolver = (params: {
  provider?: string;
  model?: string;
}) => ReturnType<typeof resolveModelCostConfig>;

function createUsageCostResolver(config?: OpenClawConfig): UsageCostResolver {
  const cache = new Map<string, ReturnType<typeof resolveModelCostConfig>>();
  return ({ provider, model }) => {
    const key = `${provider ?? ""}\0${model ?? ""}`;
    if (cache.has(key)) {
      return cache.get(key);
    }
    const cost = resolveModelCostConfig({ provider, model, config });
    cache.set(key, cost);
    return cost;
  };
}

async function canReadJsonlFromOffset(filePath: string, startOffset: number): Promise<boolean> {
  if (startOffset <= 0) {
    return true;
  }
  const handle = await fs.promises.open(filePath, "r").catch(() => null);
  if (!handle) {
    return false;
  }
  try {
    const buffer = Buffer.alloc(1);
    const result = await handle.read(buffer, 0, 1, startOffset - 1);
    return result.bytesRead === 1 && buffer[0] === 10;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

type UsageCostJsonlRecord = {
  record: Record<string, unknown>;
  lineIndex: number;
  lineText: string;
};

async function countJsonlLineBreaksBeforeOffset(filePath: string, offset: number): Promise<number> {
  if (offset <= 0) {
    return 0;
  }
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    let lineBreaks = 0;
    while (position < offset) {
      const bytesToRead = Math.min(buffer.length, offset - position);
      const result = await handle.read(buffer, 0, bytesToRead, position);
      if (result.bytesRead <= 0) {
        break;
      }
      for (let index = 0; index < result.bytesRead; index += 1) {
        if (buffer[index] === 10) {
          lineBreaks += 1;
        }
      }
      position += result.bytesRead;
    }
    return lineBreaks;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function* readJsonlRecords(
  filePath: string,
  startOffset = 0,
  endOffset?: number,
): AsyncGenerator<UsageCostJsonlRecord> {
  if (endOffset !== undefined && endOffset <= startOffset) {
    return;
  }
  let lineIndex = await countJsonlLineBreaksBeforeOffset(filePath, startOffset);
  const streamOptions: Parameters<typeof fs.createReadStream>[1] = {
    encoding: "utf-8",
    start: Math.max(0, startOffset),
  };
  if (endOffset !== undefined) {
    streamOptions.end = endOffset - 1;
  }
  const fileStream = fs.createReadStream(filePath, streamOptions);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
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
        if (!parsed || typeof parsed !== "object") {
          continue;
        }
        yield {
          record: parsed as Record<string, unknown>,
          lineIndex: currentLineIndex,
          lineText: trimmed,
        };
      } catch {
        // Ignore malformed lines
      }
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }
}

async function scanTranscriptFile(params: {
  filePath: string;
  config?: OpenClawConfig;
  resolveCost?: UsageCostResolver;
  startOffset?: number;
  endOffset?: number;
  usageIdentitySessionId?: string;
  legacyRowOccurrences?: ReadonlyMap<string, number>;
  onEntry: (entry: ParsedTranscriptEntry) => void;
}): Promise<{ usageIdentitySessionId: string; legacyRowOccurrences: Map<string, number> }> {
  const resolveCost = params.resolveCost ?? createUsageCostResolver(params.config);
  const sessionId =
    parseUsageCountedSessionIdFromFileName(path.basename(params.filePath)) ??
    path.basename(params.filePath);
  let usageIdentitySessionId = params.usageIdentitySessionId ?? sessionId;
  const legacyRowOccurrences = new Map(params.legacyRowOccurrences ?? []);
  for await (const source of readJsonlRecords(
    params.filePath,
    params.startOffset,
    params.endOffset,
  )) {
    const parsedEntry = parseTranscriptEntry(source.record);
    if (source.record.type === "session") {
      usageIdentitySessionId = resolveUsageCostTranscriptIdentitySessionId({
        filePath: params.filePath,
        fallbackSessionId: sessionId,
        header: source.record,
      });
    }
    if (!parsedEntry) {
      continue;
    }
    let legacyRowFingerprint: string | undefined;
    let legacyRowOccurrenceIndex: number | undefined;
    if (!parsedEntry.entryId) {
      legacyRowFingerprint = buildStableLegacyParsedRowFingerprint({
        usageIdentitySessionId,
        record: source.record,
      });
      legacyRowOccurrenceIndex = legacyRowOccurrences.get(legacyRowFingerprint) ?? 0;
      legacyRowOccurrences.set(legacyRowFingerprint, legacyRowOccurrenceIndex + 1);
    }
    const entry: ParsedTranscriptEntry = {
      ...parsedEntry,
      sessionId: usageIdentitySessionId,
      sourceFilePath: params.filePath,
      sourceLineIndex: source.lineIndex,
      sourceLineText: source.lineText,
      ...(legacyRowFingerprint ? { legacyRowFingerprint } : {}),
      ...(legacyRowOccurrenceIndex !== undefined ? { legacyRowOccurrenceIndex } : {}),
    };

    if (entry.usage) {
      const cost = resolveCost({
        provider: entry.provider,
        model: entry.model,
      });
      const tokenTotals = computeUsageTokenTotals(entry.usage);
      const pricingKnown = isModelPricingKnown(cost);
      const preserveRecordedZeroCost = shouldPreserveRecordedZeroCost(entry.costBreakdown);
      if (entry.usageBudgetUnpriceableCost) {
        entry.costTotal = undefined;
        entry.costBreakdown = undefined;
      } else if (entry.usageBudgetRecordedCostTotal !== undefined) {
        entry.costTotal = entry.usageBudgetRecordedCostTotal;
        entry.costBreakdown = undefined;
      } else if (
        cost?.tieredPricing &&
        cost.tieredPricing.length > 0 &&
        !preserveRecordedZeroCost
      ) {
        // Tiered pricing must override stale flat-rate provider costs. The only
        // recorded tiered cost we trust is the budget-owned bridge marker that
        // already applied a provider dispatch multiplier.
        entry.costTotal = estimateUsageCostWithRecordedMultiplier({
          usage: entry.usage,
          usageRaw: entry.message.usage,
          cost,
        });
        entry.costBreakdown = undefined;
      } else if (
        !pricingKnown &&
        !preserveRecordedZeroCost &&
        (entry.costTotal === undefined || entry.costTotal === 0) &&
        tokenTotals.totalTokens > 0
      ) {
        // Pricing for this model is unknown: it has no positive per-token rate and no
        // trustworthy recorded cost. The transport either recorded nothing or a
        // fabricated $0 derived from an all-zero/default catalog entry. Surface this
        // token-burning turn as a missing-cost entry instead of recording a confident
        // $0, so budget and spike safeguards that read totalCost are not left blind to
        // it. A turn carrying a real positive recorded cost is preserved by the guard
        // above.
        entry.costTotal = undefined;
        entry.costBreakdown = undefined;
      } else if (
        entry.costTotal === undefined ||
        shouldRecomputeRecordedZeroCost({
          usage: entry.usage,
          cost,
          costBreakdown: entry.costBreakdown,
          costTotal: entry.costTotal,
        })
      ) {
        // Fill in missing estimates and override fabricated API-provided zeros
        // for known-priced models such as DeepSeek V4. Providers that reconcile
        // only the total keep their authoritative zero when components are nonzero.
        entry.costTotal = estimateUsageCostWithRecordedMultiplier({
          usage: entry.usage,
          usageRaw: entry.message.usage,
          cost,
        });
        entry.costBreakdown = undefined;
      }
    }

    params.onEntry(entry);
  }
  return { usageIdentitySessionId, legacyRowOccurrences };
}

async function scanUsageFile(params: {
  filePath: string;
  config?: OpenClawConfig;
  resolveCost?: UsageCostResolver;
  startOffset?: number;
  endOffset?: number;
  onEntry: (entry: ParsedUsageEntry) => void;
}): Promise<void> {
  await scanTranscriptFile({
    filePath: params.filePath,
    config: params.config,
    resolveCost: params.resolveCost,
    startOffset: params.startOffset,
    endOffset: params.endOffset,
    onEntry: (entry) => {
      if (!entry.usage) {
        return;
      }
      params.onEntry({
        entryId: entry.entryId ?? buildLegacyParsedUsageRecordId(entry),
        dedupKey: buildParsedUsageDedupKey(entry),
        ...(entry.sourceFilePath ? { sourceFilePath: entry.sourceFilePath } : {}),
        ...(entry.sourceLineIndex !== undefined ? { sourceLineIndex: entry.sourceLineIndex } : {}),
        source: entry.source,
        ...(entry.usageBudgetOperationId
          ? { usageBudgetOperationId: entry.usageBudgetOperationId }
          : {}),
        usage: entry.usage,
        costTotal: entry.costTotal,
        costBreakdown: entry.costBreakdown,
        usageBudgetRecordedCostTotal: entry.usageBudgetRecordedCostTotal,
        provider: entry.provider,
        model: entry.model,
        timestamp: entry.timestamp,
      });
    },
  });
}

export function resolveExistingUsageSessionFile(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  agentId?: string;
}): string | undefined {
  const candidate =
    params.sessionFile ??
    (params.sessionId
      ? resolveSessionFilePath(params.sessionId, params.sessionEntry, {
          agentId: params.agentId,
        })
      : undefined);

  if (candidate && fs.existsSync(candidate)) {
    return candidate;
  }

  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return candidate;
  }

  try {
    const sessionsDir = candidate
      ? path.dirname(candidate)
      : resolveSessionTranscriptsDirForAgent(params.agentId);
    const baseFileName = `${sessionId}.jsonl`;
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => {
      return (
        entry.isFile() &&
        (entry.name === baseFileName ||
          entry.name.startsWith(`${baseFileName}.reset.`) ||
          entry.name.startsWith(`${baseFileName}.deleted.`))
      );
    });

    const primary = entries.find((entry) => entry.name === baseFileName);
    if (primary) {
      return path.join(sessionsDir, primary.name);
    }

    const latestArchive = entries
      .filter((entry) => isSessionArchiveArtifactName(entry.name))
      .map((entry) => entry.name)
      .toSorted((a, b) => {
        const tsA =
          parseSessionArchiveTimestamp(a, "deleted") ??
          parseSessionArchiveTimestamp(a, "reset") ??
          0;
        const tsB =
          parseSessionArchiveTimestamp(b, "deleted") ??
          parseSessionArchiveTimestamp(b, "reset") ??
          0;
        return tsB - tsA || b.localeCompare(a);
      })[0];

    return latestArchive ? path.join(sessionsDir, latestArchive) : candidate;
  } catch {
    return candidate;
  }
}

export async function loadCostUsageSummary(params?: {
  startMs?: number;
  endMs?: number;
  /** @deprecated Use startMs/endMs. */
  days?: number;
  config?: OpenClawConfig;
  agentId?: string;
}): Promise<CostUsageSummary> {
  const now = new Date();
  let sinceTime: number;
  let untilTime: number;

  if (params?.startMs !== undefined && params?.endMs !== undefined) {
    sinceTime = params.startMs;
    untilTime = params.endMs;
  } else {
    // Fallback to days-based calculation for backwards compatibility
    const days = Math.max(1, Math.floor(params?.days ?? 30));
    const since = new Date(now);
    since.setDate(since.getDate() - (days - 1));
    sinceTime = since.getTime();
    untilTime = now.getTime();
  }

  const dailyMap = new Map<string, CostUsageTotals>();
  const totals = emptyTotals();
  const resolveCost = createUsageCostResolver(params?.config);
  const usageEntries: ParsedUsageEntry[] = [];

  const files = await listUsageCountedTranscriptFileStats(params?.agentId, {
    minMtimeMs: sinceTime - USAGE_COST_BRIDGE_RECONCILIATION_LOOKBACK_MS,
  });

  for (const file of files) {
    await scanUsageFile({
      filePath: file.filePath,
      config: params?.config,
      resolveCost,
      onEntry: (entry) => {
        usageEntries.push(entry);
      },
    });
  }
  for (const ledgerEntry of loadAgentUsageBudgetLedgerAccountedEntries({
    agentId: params?.agentId,
    minStartMs: sinceTime - USAGE_COST_BRIDGE_RECONCILIATION_LOOKBACK_MS,
    config: params?.config,
  })) {
    const entry = parsedUsageEntryFromLedger(ledgerEntry);
    if (!entry) {
      continue;
    }
    usageEntries.push(entry);
  }

  for (const entry of collectCanonicalUsageBridgeEntries(usageEntries)) {
    const ts = entry.timestamp?.getTime();
    if (!ts || ts < sinceTime || ts > untilTime) {
      continue;
    }
    const dayKey = formatDayKey(entry.timestamp ?? now);
    const bucket = dailyMap.get(dayKey) ?? emptyTotals();
    applyUsageTotals(bucket, entry.usage);
    if (entry.costBreakdown?.total !== undefined) {
      applyCostBreakdown(bucket, entry.costBreakdown);
    } else {
      applyCostTotal(bucket, entry.costTotal);
    }
    dailyMap.set(dayKey, bucket);

    applyUsageTotals(totals, entry.usage);
    if (entry.costBreakdown?.total !== undefined) {
      applyCostBreakdown(totals, entry.costBreakdown);
    } else {
      applyCostTotal(totals, entry.costTotal);
    }
  }

  fillMissingDays(dailyMap, sinceTime, untilTime);

  const daily = Array.from(dailyMap.entries())
    .map(([date, bucket]) => Object.assign({ date }, bucket))
    .toSorted((a, b) => a.date.localeCompare(b.date));

  // Calculate days for backwards compatibility in response
  const days = Math.ceil((untilTime - sinceTime) / (24 * 60 * 60 * 1000)) + 1;

  return {
    updatedAt: Date.now(),
    days,
    daily,
    totals,
  };
}

async function scanUsageFileForCache(params: {
  file: UsageCostTranscriptFile;
  config?: OpenClawConfig;
  resolveCost?: UsageCostResolver;
  previous?: UsageCostCacheFileEntry;
  includeSessionSummary?: boolean;
}): Promise<UsageCostCacheFileEntry> {
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config);
  const appendOnlyPreviousCandidate =
    params.previous &&
    params.previous.filePath === params.file.filePath &&
    params.previous.size > 0 &&
    params.previous.size < params.file.size &&
    params.previous.pricingFingerprint === pricingFingerprint &&
    params.previous.mtimeMs <= params.file.mtimeMs
      ? params.previous
      : undefined;
  const appendOnlyPrevious =
    appendOnlyPreviousCandidate &&
    (!params.includeSessionSummary || appendOnlyPreviousCandidate.transcriptEntries)
      ? appendOnlyPreviousCandidate
      : undefined;
  const totals = emptyTotals();
  const usageEntries: UsageCostCachedUsageEntry[] = [];
  const shouldTrackTranscriptEntries =
    params.includeSessionSummary || Boolean(appendOnlyPrevious?.transcriptEntries);
  const transcriptEntries: UsageCostCachedTranscriptEntry[] | undefined =
    shouldTrackTranscriptEntries ? [] : undefined;
  let parsedRecords = 0;
  let countedRecords = 0;
  const startOffset =
    appendOnlyPrevious &&
    (await canReadJsonlFromOffset(params.file.filePath, appendOnlyPrevious.size))
      ? appendOnlyPrevious.size
      : undefined;

  const transcriptScan = await scanTranscriptFile({
    filePath: params.file.filePath,
    config: params.config,
    resolveCost: params.resolveCost,
    startOffset,
    endOffset: params.file.size,
    usageIdentitySessionId: appendOnlyPrevious?.usageIdentitySessionId,
    legacyRowOccurrences:
      appendOnlyPrevious && startOffset !== undefined
        ? new Map(Object.entries(appendOnlyPrevious.legacyRowOccurrences ?? {}))
        : undefined,
    onEntry: (entry) => {
      const ts = entry.timestamp?.getTime();
      let entryTotals: CostUsageTotals | undefined;
      if (entry.usage) {
        parsedRecords += 1;
        entryTotals = emptyTotals();
        applyUsageTotals(entryTotals, entry.usage);
        if (entry.costBreakdown?.total !== undefined) {
          applyCostBreakdown(entryTotals, entry.costBreakdown);
        } else {
          applyCostTotal(entryTotals, entry.costTotal);
        }
        addTotals(totals, entryTotals);
        if (ts !== undefined) {
          countedRecords += 1;
          const dedupKey = buildParsedUsageDedupKey(entry);
          usageEntries.push({
            entryId: entry.entryId ?? buildLegacyParsedUsageRecordId(entry),
            ...(dedupKey ? { dedupKey } : {}),
            ...(entry.sourceFilePath ? { sourceFilePath: entry.sourceFilePath } : {}),
            ...(entry.sourceLineIndex !== undefined
              ? { sourceLineIndex: entry.sourceLineIndex }
              : {}),
            source: entry.source,
            ...(entry.usageBudgetOperationId
              ? { usageBudgetOperationId: entry.usageBudgetOperationId }
              : {}),
            ...(entry.usageBudgetRecordedCostTotal !== undefined
              ? { usageBudgetRecordedCostTotal: entry.usageBudgetRecordedCostTotal }
              : {}),
            timestamp: ts,
            provider: entry.provider,
            model: entry.model,
            ...entryTotals,
          });
        }
      }

      transcriptEntries?.push({
        source: entry.source,
        ...(entry.usageBudgetOperationId
          ? { usageBudgetOperationId: entry.usageBudgetOperationId }
          : {}),
        timestamp: ts,
        role: entry.role,
        durationMs: entry.durationMs,
        provider: entry.provider,
        model: entry.model,
        stopReason: entry.stopReason,
        toolNames: entry.toolNames,
        toolResultCounts: entry.toolResultCounts,
        usageTotals: entryTotals ? cloneTotals(entryTotals) : undefined,
      });
    },
  });
  const { usageIdentitySessionId, legacyRowOccurrences } = transcriptScan;

  const sessionId =
    parseUsageCountedSessionIdFromFileName(path.basename(params.file.filePath)) ?? undefined;
  const combinedTranscriptEntries = shouldTrackTranscriptEntries
    ? [
        ...((appendOnlyPrevious && startOffset !== undefined
          ? appendOnlyPrevious.transcriptEntries
          : undefined) ?? []),
        ...(transcriptEntries ?? []),
      ]
    : undefined;
  const sessionSummary =
    combinedTranscriptEntries &&
    (params.includeSessionSummary || appendOnlyPrevious?.sessionSummary)
      ? (buildSessionCostSummaryFromCacheEntry({
          entry: {
            filePath: params.file.filePath,
            size: params.file.size,
            mtimeMs: params.file.mtimeMs,
            pricingFingerprint,
            scannedAt: Date.now(),
            usageIdentitySessionId,
            parsedRecords,
            countedRecords,
            usageEntries,
            transcriptEntries: combinedTranscriptEntries,
            totals,
            sessionId,
          },
          sessionId,
          sessionFile: params.file.filePath,
          startMs: Number.NEGATIVE_INFINITY,
          endMs: Number.POSITIVE_INFINITY,
        }) ?? undefined)
      : undefined;

  if (appendOnlyPrevious && startOffset !== undefined) {
    const previousTotals = cloneTotals(appendOnlyPrevious.totals);
    addTotals(previousTotals, totals);
    return {
      ...appendOnlyPrevious,
      size: params.file.size,
      mtimeMs: params.file.mtimeMs,
      pricingFingerprint,
      scannedAt: Date.now(),
      usageIdentitySessionId,
      legacyRowOccurrences: Object.fromEntries(legacyRowOccurrences),
      parsedRecords: appendOnlyPrevious.parsedRecords + parsedRecords,
      countedRecords: appendOnlyPrevious.countedRecords + countedRecords,
      usageEntries: [...appendOnlyPrevious.usageEntries, ...usageEntries],
      transcriptEntries: combinedTranscriptEntries,
      totals: previousTotals,
      sessionSummary,
    };
  }

  return {
    filePath: params.file.filePath,
    size: params.file.size,
    mtimeMs: params.file.mtimeMs,
    pricingFingerprint,
    scannedAt: Date.now(),
    usageIdentitySessionId,
    legacyRowOccurrences: Object.fromEntries(legacyRowOccurrences),
    parsedRecords,
    countedRecords,
    usageEntries,
    transcriptEntries: combinedTranscriptEntries,
    totals,
    sessionId,
    sessionSummary,
  };
}

async function refreshCostUsageCacheForPath(params?: {
  config?: OpenClawConfig;
  agentId?: string;
  cachePath?: string;
  maxFiles?: number;
  sessionsDir?: string;
  sessionFiles?: string[];
  startMs?: number;
}): Promise<UsageCostRefreshResult> {
  const cachePath = params?.cachePath ?? resolveUsageCostCachePath(params?.agentId);
  const lock = await acquireUsageCostCacheRefreshLock(cachePath);
  if (!lock.acquired) {
    return "busy";
  }
  try {
    await cleanupStaleUsageCostCacheTempFiles(cachePath);
    const pricingFingerprint = resolveUsageCostPricingFingerprint(params?.config);
    const cache = await readUsageCostCache(cachePath);
    const files = await listUsageCountedTranscriptFiles(params?.agentId, {
      sessionsDir: params?.sessionsDir,
    });
    const sessionSummaryFiles = new Set(params?.sessionFiles ?? []);
    const refreshStartMs = params?.startMs;
    const refreshFiles =
      sessionSummaryFiles.size > 0
        ? files.filter((file) => sessionSummaryFiles.has(file.filePath))
        : refreshStartMs === undefined
          ? files
          : files.filter((file) => file.mtimeMs >= refreshStartMs);
    const livePaths = new Set(files.map((file) => file.filePath));
    let cacheMutated = false;
    for (const filePath of Object.keys(cache.files)) {
      if (!livePaths.has(filePath)) {
        delete cache.files[filePath];
        cacheMutated = true;
      }
    }

    const maxFiles =
      params?.maxFiles !== undefined && Number.isFinite(params.maxFiles) && params.maxFiles > 0
        ? Math.floor(params.maxFiles)
        : undefined;
    const staleFiles = getUsageCostStaleFiles({
      cache,
      files: refreshFiles,
      pricingFingerprint,
      sessionSummaryFiles,
    })
      .toSorted((a, b) => {
        const aSession = sessionSummaryFiles.has(a.filePath) ? 0 : 1;
        const bSession = sessionSummaryFiles.has(b.filePath) ? 0 : 1;
        return aSession - bSession || a.size - b.size || a.filePath.localeCompare(b.filePath);
      })
      .slice(0, maxFiles);
    const resolveCost = createUsageCostResolver(params?.config);

    // Throttle full cache rewrites: writing a 100MB+ JSON cache after every
    // single scanned session balloons CPU/IO into O(N * cacheSize). Instead,
    // checkpoint at most once every USAGE_COST_CACHE_CHECKPOINT_INTERVAL_MS
    // (or every USAGE_COST_CACHE_CHECKPOINT_FILES files) so an interrupted
    // refresh still makes durable forward progress while a normal refresh of
    // thousands of files only pays the serialization cost a handful of times.
    let dirtyCount = 0;
    let lastCheckpointMs = Date.now();
    for (const file of staleFiles) {
      cache.files[file.filePath] = await scanUsageFileForCache({
        file,
        config: params?.config,
        resolveCost,
        previous: cache.files[file.filePath],
        includeSessionSummary: sessionSummaryFiles.has(file.filePath),
      });
      dirtyCount += 1;
      cacheMutated = true;
      const now = Date.now();
      if (
        dirtyCount >= USAGE_COST_CACHE_CHECKPOINT_FILES ||
        now - lastCheckpointMs >= USAGE_COST_CACHE_CHECKPOINT_INTERVAL_MS
      ) {
        cache.updatedAt = now;
        await writeUsageCostCache(cachePath, cache);
        dirtyCount = 0;
        lastCheckpointMs = Date.now();
      }
    }

    if (cacheMutated || dirtyCount > 0) {
      cache.updatedAt = Date.now();
      await writeUsageCostCache(cachePath, cache);
    }
    return "refreshed";
  } finally {
    await lock.release();
  }
}

export async function refreshCostUsageCache(params?: {
  config?: OpenClawConfig;
  agentId?: string;
  maxFiles?: number;
  sessionFiles?: string[];
  startMs?: number;
}): Promise<UsageCostRefreshResult> {
  return await refreshCostUsageCacheForPath(params);
}

export async function loadCostUsageSummaryFromCache(params: {
  startMs: number;
  endMs: number;
  config?: OpenClawConfig;
  agentId?: string;
  requestRefresh?: boolean;
  refreshMode?: "background" | "sync-when-empty";
}): Promise<CostUsageSummary> {
  const cachePath = resolveUsageCostCachePath(params.agentId);
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config);
  let [cache, files] = await Promise.all([
    readUsageCostCache(cachePath),
    listUsageCountedTranscriptFiles(params.agentId),
  ]);
  const staleFiles = getUsageCostStaleFiles({
    cache,
    files,
    pricingFingerprint,
  });
  if (params.requestRefresh !== false && staleFiles.length > 0) {
    const cachedFiles = countUsableUsageCostCacheFiles({
      cache,
      files,
      pricingFingerprint,
    });
    if (params.refreshMode === "sync-when-empty" && cachedFiles === 0) {
      const result = await refreshCostUsageCache({
        config: params.config,
        agentId: params.agentId,
        startMs: params.startMs,
      });
      [cache, files] = await Promise.all([
        readUsageCostCache(cachePath),
        listUsageCountedTranscriptFiles(params.agentId),
      ]);
      if (result === "refreshed") {
        const remainingStaleFiles = getUsageCostStaleFiles({
          cache,
          files,
          pricingFingerprint,
        });
        if (remainingStaleFiles.length > 0) {
          requestCostUsageCacheRefresh({ config: params.config, agentId: params.agentId });
        }
      }
    } else {
      requestCostUsageCacheRefresh({ config: params.config, agentId: params.agentId });
    }
  }
  const refreshRunning = await isUsageCostCacheRefreshRunning(cachePath);
  const ledgerEntries = loadAgentUsageBudgetLedgerAccountedEntries({
    agentId: params.agentId,
    minStartMs: params.startMs - USAGE_COST_BRIDGE_RECONCILIATION_LOOKBACK_MS,
    config: params.config,
  });
  return buildCostUsageSummaryFromCache({
    cache,
    files,
    ledgerEntries,
    startMs: params.startMs,
    endMs: params.endMs,
    pricingFingerprint,
    refreshing: usageCostRefreshes.has(cachePath) || refreshRunning,
  });
}

export async function loadSessionCostSummaryFromCache(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile: string;
  config?: OpenClawConfig;
  agentId?: string;
  startMs?: number;
  endMs?: number;
  requestRefresh?: boolean;
  refreshMode?: "background" | "sync-when-empty";
}): Promise<{ summary: SessionCostSummary | null; cacheStatus: UsageCacheStatus }> {
  const cachePath = resolveUsageCostCachePath(params.agentId);
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config);
  let [cache, stats] = await Promise.all([
    readUsageCostCache(cachePath),
    fs.promises.stat(params.sessionFile).catch(() => null),
  ]);
  let file = stats
    ? { filePath: params.sessionFile, size: stats.size, mtimeMs: stats.mtimeMs }
    : undefined;
  let entry = cache.files[params.sessionFile];
  let stale =
    !file ||
    !isUsageCostCacheEntryFresh({
      entry,
      file,
      pricingFingerprint,
      requireSessionSummary: true,
    });
  let refreshRequested = false;
  if (params.requestRefresh !== false && stale) {
    if (params.refreshMode === "sync-when-empty") {
      const result = await refreshCostUsageCache({
        config: params.config,
        agentId: params.agentId,
        sessionFiles: [params.sessionFile],
      });
      if (result === "refreshed") {
        [cache, stats] = await Promise.all([
          readUsageCostCache(cachePath),
          fs.promises.stat(params.sessionFile).catch(() => null),
        ]);
        file = stats
          ? { filePath: params.sessionFile, size: stats.size, mtimeMs: stats.mtimeMs }
          : undefined;
        entry = cache.files[params.sessionFile];
        stale =
          !file ||
          !isUsageCostCacheEntryFresh({
            entry,
            file,
            pricingFingerprint,
            requireSessionSummary: true,
          });
      } else {
        requestCostUsageCacheRefresh({
          config: params.config,
          agentId: params.agentId,
          sessionFiles: [params.sessionFile],
        });
        refreshRequested = true;
      }
    } else {
      requestCostUsageCacheRefresh({
        config: params.config,
        agentId: params.agentId,
        sessionFiles: [params.sessionFile],
      });
      refreshRequested = true;
    }
  }
  const refreshRunning =
    usageCostRefreshes.has(cachePath) || (await isUsageCostCacheRefreshRunning(cachePath));
  let summary = stale ? null : (entry?.sessionSummary ?? null);
  if (!summary && params.refreshMode === "sync-when-empty") {
    summary = await loadSessionCostSummary({
      sessionId: params.sessionId,
      sessionEntry: params.sessionEntry,
      sessionFile: params.sessionFile,
      config: params.config,
      agentId: params.agentId,
      startMs: params.startMs,
      endMs: params.endMs,
    });
  }
  if (
    summary &&
    params.startMs !== undefined &&
    params.endMs !== undefined &&
    !isSessionSummaryContainedInRange(summary, params.startMs, params.endMs)
  ) {
    summary = entry
      ? buildSessionCostSummaryFromCacheEntry({
          entry,
          sessionId: params.sessionId,
          sessionFile: params.sessionFile,
          startMs: params.startMs,
          endMs: params.endMs,
        })
      : params.refreshMode === "sync-when-empty"
        ? await loadSessionCostSummary({
            sessionId: params.sessionId,
            sessionEntry: params.sessionEntry,
            sessionFile: params.sessionFile,
            config: params.config,
            agentId: params.agentId,
            startMs: params.startMs,
            endMs: params.endMs,
          })
        : null;
  }
  return {
    summary,
    cacheStatus: {
      status: stale
        ? refreshRunning || refreshRequested
          ? "refreshing"
          : summary
            ? "partial"
            : "stale"
        : "fresh",
      cachedFiles: stale ? 0 : 1,
      pendingFiles: stale ? 1 : 0,
      staleFiles: stale ? 1 : 0,
      refreshedAt: cache.updatedAt || undefined,
    },
  };
}

export async function loadSessionCostSummariesFromCache(params: {
  sessions: Array<{ sessionId?: string; sessionFile: string }>;
  config?: OpenClawConfig;
  agentId?: string;
  startMs?: number;
  endMs?: number;
  requestRefresh?: boolean;
}): Promise<{ summaries: Array<SessionCostSummary | null>; cacheStatus: UsageCacheStatus }> {
  const cachePath = resolveUsageCostCachePath(params.agentId);
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config);
  const statTasks = params.sessions.map(
    (session) => async () => await fs.promises.stat(session.sessionFile).catch(() => null),
  );
  const statsPromise = runTasksWithConcurrency({
    tasks: statTasks,
    limit: USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY,
  }).then(({ results }) => results);
  const [cache, stats, refreshRunning] = await Promise.all([
    readUsageCostCache(cachePath),
    statsPromise,
    isUsageCostCacheRefreshRunning(cachePath),
  ]);
  const staleFiles = new Set<string>();
  let cachedFiles = 0;
  const summaries = params.sessions.map((session, index) => {
    const stat = stats[index];
    const file = stat
      ? { filePath: session.sessionFile, size: stat.size, mtimeMs: stat.mtimeMs }
      : undefined;
    const entry = cache.files[session.sessionFile];
    const stale =
      !file ||
      !isUsageCostCacheEntryFresh({
        entry,
        file,
        pricingFingerprint,
        requireSessionSummary: true,
      });
    if (stale) {
      staleFiles.add(session.sessionFile);
      return null;
    }
    cachedFiles += 1;
    const summary = entry?.sessionSummary ?? null;
    if (
      summary &&
      params.startMs !== undefined &&
      params.endMs !== undefined &&
      !isSessionSummaryContainedInRange(summary, params.startMs, params.endMs)
    ) {
      return entry
        ? buildSessionCostSummaryFromCacheEntry({
            entry,
            sessionId: session.sessionId,
            sessionFile: session.sessionFile,
            startMs: params.startMs,
            endMs: params.endMs,
          })
        : null;
    }
    return summary;
  });
  const refreshRequested = params.requestRefresh !== false && staleFiles.size > 0;
  if (refreshRequested) {
    requestCostUsageCacheRefresh({
      config: params.config,
      agentId: params.agentId,
      sessionFiles: [...staleFiles],
    });
  }
  const staleFileCount = staleFiles.size;
  return {
    summaries,
    cacheStatus: {
      status:
        staleFileCount === 0
          ? "fresh"
          : refreshRunning || refreshRequested
            ? "refreshing"
            : cachedFiles > 0
              ? "partial"
              : "stale",
      cachedFiles,
      pendingFiles: staleFileCount,
      staleFiles: staleFileCount,
      refreshedAt: cache.updatedAt || undefined,
    },
  };
}

export function requestCostUsageCacheRefresh(params?: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionFiles?: string[];
}): void {
  const cachePath = resolveUsageCostCachePath(params?.agentId);
  const existing = usageCostRefreshes.get(cachePath);
  if (existing) {
    mergeUsageCostRefreshRequest(existing, params);
    return;
  }

  const state: UsageCostRefreshState = {
    agentId: params?.agentId,
    cachePath,
    config: params?.config,
    fullRefreshRequested: false,
    pendingSessionFiles: new Set(),
    running: false,
    sessionsDir: path.dirname(cachePath),
  };
  mergeUsageCostRefreshRequest(state, params);
  usageCostRefreshes.set(cachePath, state);
  scheduleUsageCostRefresh(cachePath, state);
}

function mergeUsageCostRefreshRequest(
  state: UsageCostRefreshState,
  params?: {
    config?: OpenClawConfig;
    agentId?: string;
    sessionFiles?: string[];
  },
): void {
  if (params?.config) {
    state.config = params.config;
  }
  if (params?.agentId) {
    state.agentId = params.agentId;
  }
  if (!params?.sessionFiles) {
    state.fullRefreshRequested = true;
    return;
  }
  for (const sessionFile of params.sessionFiles) {
    state.pendingSessionFiles.add(sessionFile);
  }
}

function scheduleUsageCostRefresh(
  refreshKey: string,
  state: UsageCostRefreshState,
  delayMs = 0,
): void {
  if (state.running || state.timer) {
    return;
  }
  const timer = setTimeout(() => {
    state.timer = undefined;
    void runQueuedUsageCostRefresh(refreshKey, state);
  }, delayMs);
  timer.unref?.();
  state.timer = timer;
}

async function runQueuedUsageCostRefresh(
  refreshKey: string,
  state: UsageCostRefreshState,
): Promise<void> {
  state.running = true;
  let retryDelayMs = 0;
  try {
    while (state.fullRefreshRequested || state.pendingSessionFiles.size > 0) {
      const fullRefreshRequested = state.fullRefreshRequested;
      const sessionFiles = fullRefreshRequested ? [] : [...state.pendingSessionFiles];
      if (!fullRefreshRequested) {
        state.pendingSessionFiles.clear();
      }
      state.fullRefreshRequested = false;
      const result = await refreshCostUsageCacheForPath({
        cachePath: state.cachePath,
        config: state.config,
        agentId: state.agentId,
        sessionsDir: state.sessionsDir,
        sessionFiles: fullRefreshRequested ? undefined : sessionFiles,
      });
      if (result === "busy") {
        if (fullRefreshRequested) {
          state.fullRefreshRequested = true;
        } else {
          for (const sessionFile of sessionFiles) {
            state.pendingSessionFiles.add(sessionFile);
          }
        }
        retryDelayMs = 50;
        break;
      }
    }
  } catch (error) {
    logger.warn(`background refresh failed: ${formatErrorMessage(error)}`, { error });
  } finally {
    state.running = false;
    if (state.fullRefreshRequested || state.pendingSessionFiles.size > 0) {
      scheduleUsageCostRefresh(refreshKey, state, retryDelayMs);
    } else {
      usageCostRefreshes.delete(refreshKey);
    }
  }
}

/**
 * Scan all transcript files to discover sessions not in the session store.
 * Returns basic metadata for each discovered session.
 */
export async function discoverAllSessions(params?: {
  agentId?: string;
  startMs?: number;
  endMs?: number;
  includeFirstUserMessage?: boolean;
}): Promise<DiscoveredSession[]> {
  const files = await listUsageCountedTranscriptFileStats(params?.agentId, {
    minMtimeMs: params?.startMs,
  });

  const discovered = new Map<string, DiscoveredSession>();

  for (const file of files) {
    // Do not exclude by endMs: a session can have activity in range even if it continued later.
    const filePath = file.filePath;
    const fileName = path.basename(filePath);

    const sessionId = parseUsageCountedSessionIdFromFileName(fileName);
    if (!sessionId) {
      continue;
    }
    const isPrimaryTranscript = isPrimarySessionTranscriptFileName(fileName);

    // Try to read first user message for label extraction
    let firstUserMessage: string | undefined;
    if (params?.includeFirstUserMessage !== false) {
      try {
        for await (const source of readJsonlRecords(filePath)) {
          try {
            const parsed = source.record;
            const message = parsed.message as Record<string, unknown> | undefined;
            if (message?.role === "user") {
              const content = message.content;
              if (typeof content === "string") {
                firstUserMessage = content.slice(0, 100);
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (
                    typeof block === "object" &&
                    block &&
                    (block as Record<string, unknown>).type === "text"
                  ) {
                    const text = (block as Record<string, unknown>).text;
                    if (typeof text === "string") {
                      firstUserMessage = text.slice(0, 100);
                    }
                    break;
                  }
                }
              }
              break; // Found first user message
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    const existing = discovered.get(sessionId);
    const existingIsPrimary = existing
      ? isPrimarySessionTranscriptFileName(path.basename(existing.sessionFile))
      : false;
    const shouldReplace =
      !existing ||
      (isPrimaryTranscript && !existingIsPrimary) ||
      (isPrimaryTranscript === existingIsPrimary && file.mtimeMs >= existing.mtime);

    if (shouldReplace) {
      discovered.set(sessionId, {
        sessionId,
        sessionFile: filePath,
        mtime: file.mtimeMs,
        firstUserMessage: firstUserMessage ?? existing?.firstUserMessage,
      });
      continue;
    }

    if (!existing.firstUserMessage && firstUserMessage) {
      existing.firstUserMessage = firstUserMessage;
      discovered.set(sessionId, existing);
    }
  }

  // Sort by mtime descending (most recent first)
  return Array.from(discovered.values()).toSorted((a, b) => b.mtime - a.mtime);
}

export async function loadSessionCostSummary(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId?: string;
  startMs?: number;
  endMs?: number;
}): Promise<SessionCostSummary | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return null;
  }

  const totals = emptyTotals();
  let firstActivity: number | undefined;
  let lastActivity: number | undefined;
  const activityDatesSet = new Set<string>();
  const dailyMap = new Map<string, { tokens: number; cost: number }>();
  const dailyMessageMap = new Map<string, SessionDailyMessageCounts>();
  const utcQuarterHourMessageMap = new Map<string, SessionUtcQuarterHourMessageCounts>();
  const utcQuarterHourTokenMap = new Map<string, SessionUtcQuarterHourTokenUsage>();
  const dailyLatencyMap = new Map<string, number[]>();
  const dailyModelUsageMap = new Map<string, SessionDailyModelUsage>();
  const messageCounts: SessionMessageCounts = {
    total: 0,
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  };
  const toolUsageMap = new Map<string, number>();
  const modelUsageMap = new Map<string, SessionModelUsage>();
  const errorStopReasons = new Set(["error", "aborted", "timeout"]);
  const latencyValues: number[] = [];
  let lastUserTimestamp: number | undefined;
  const MAX_LATENCY_MS = 12 * 60 * 60 * 1000;
  const resolveCost = createUsageCostResolver(params.config);
  const usageEntries: ParsedTranscriptEntry[] = [];

  await scanTranscriptFile({
    filePath: sessionFile,
    config: params.config,
    resolveCost,
    onEntry: (entry) => {
      const ts = entry.timestamp?.getTime();

      if (!timestampInReportRange(ts, params.startMs, params.endMs)) {
        if (
          entry.usage &&
          entry.source === "model_call_custom" &&
          timestampInUsageBridgeReconciliationRange(ts, params.startMs, params.endMs)
        ) {
          usageEntries.push(entry);
        }
        return;
      }

      if (ts !== undefined) {
        if (!firstActivity || ts < firstActivity) {
          firstActivity = ts;
        }
        if (!lastActivity || ts > lastActivity) {
          lastActivity = ts;
        }
      }

      if (entry.role === "user") {
        messageCounts.user += 1;
        messageCounts.total += 1;
        if (entry.timestamp) {
          lastUserTimestamp = entry.timestamp.getTime();
        }
      }
      if (entry.role === "assistant") {
        messageCounts.assistant += 1;
        messageCounts.total += 1;
        const tsLocal = entry.timestamp?.getTime();
        if (tsLocal !== undefined) {
          const latencyMs =
            entry.durationMs ??
            (lastUserTimestamp !== undefined
              ? Math.max(0, tsLocal - lastUserTimestamp)
              : undefined);
          if (
            latencyMs !== undefined &&
            Number.isFinite(latencyMs) &&
            latencyMs <= MAX_LATENCY_MS
          ) {
            latencyValues.push(latencyMs);
            const dayKey = formatDayKey(entry.timestamp ?? new Date(tsLocal));
            const dailyLatencies = dailyLatencyMap.get(dayKey) ?? [];
            dailyLatencies.push(latencyMs);
            dailyLatencyMap.set(dayKey, dailyLatencies);
          }
        }
      }

      if (entry.toolNames.length > 0) {
        messageCounts.toolCalls += entry.toolNames.length;
        for (const name of entry.toolNames) {
          toolUsageMap.set(name, (toolUsageMap.get(name) ?? 0) + 1);
        }
      }

      if (entry.toolResultCounts.total > 0) {
        messageCounts.toolResults += entry.toolResultCounts.total;
        messageCounts.errors += entry.toolResultCounts.errors;
      }

      if (entry.stopReason && errorStopReasons.has(entry.stopReason)) {
        messageCounts.errors += 1;
      }

      if (entry.timestamp) {
        const dayKey = formatDayKey(entry.timestamp);
        activityDatesSet.add(dayKey);
        const daily = dailyMessageMap.get(dayKey) ?? {
          date: dayKey,
          total: 0,
          user: 0,
          assistant: 0,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        };
        accumulateMessageCounts(daily, entry, errorStopReasons);
        dailyMessageMap.set(dayKey, daily);

        // Per-quarter-hour message counts for precise hourly stats (UTC-based)
        const quarterBucket = getUtcQuarterHourBucketKey(entry.timestamp);
        const utcQuarterHour = utcQuarterHourMessageMap.get(quarterBucket.key) ?? {
          date: quarterBucket.date,
          quarterIndex: quarterBucket.quarterIndex,
          total: 0,
          user: 0,
          assistant: 0,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        };
        accumulateMessageCounts(utcQuarterHour, entry, errorStopReasons);
        utcQuarterHourMessageMap.set(quarterBucket.key, utcQuarterHour);
      }

      if (!entry.usage) {
        return;
      }

      usageEntries.push(entry);
    },
  });

  const consumedModelCallBridgeOwnerIndexes = new Set<number>();
  const consumedModelCallBridgeIndexes = new Set<number>();
  for (const [entryIndex, entry] of usageEntries.entries()) {
    if (
      skipModelCallBridgeUsageEntry({
        entry,
        entryIndex,
        entries: usageEntries,
        consumedOwnerIndexes: consumedModelCallBridgeOwnerIndexes,
        consumedBridgeIndexes: consumedModelCallBridgeIndexes,
      })
    ) {
      continue;
    }
    if (!entry.usage) {
      continue;
    }

    applyUsageTotals(totals, entry.usage);
    if (entry.costBreakdown?.total !== undefined) {
      applyCostBreakdown(totals, entry.costBreakdown);
    } else {
      applyCostTotal(totals, entry.costTotal);
    }

    if (entry.timestamp) {
      const dayKey = formatDayKey(entry.timestamp);
      const entryTokenTotals = computeUsageTokenTotals(entry.usage);
      // Preserve the legacy dailyBreakdown token basis until daily metrics are
      // refactored separately. The precise quarter-hour bucket below uses
      // entryTokenTotals.totalTokens so Usage Mosaic matches session totals.
      const entryTokens = entryTokenTotals.componentTotal;
      const entryCost =
        entry.costBreakdown?.total ??
        (entry.costBreakdown
          ? (entry.costBreakdown.input ?? 0) +
            (entry.costBreakdown.output ?? 0) +
            (entry.costBreakdown.cacheRead ?? 0) +
            (entry.costBreakdown.cacheWrite ?? 0)
          : (entry.costTotal ?? 0));

      const quarterBucket = getUtcQuarterHourBucketKey(entry.timestamp);
      const utcQuarterHourToken = utcQuarterHourTokenMap.get(quarterBucket.key) ?? {
        date: quarterBucket.date,
        quarterIndex: quarterBucket.quarterIndex,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        totalCost: 0,
      };
      utcQuarterHourToken.input += entryTokenTotals.input;
      utcQuarterHourToken.output += entryTokenTotals.output;
      utcQuarterHourToken.cacheRead += entryTokenTotals.cacheRead;
      utcQuarterHourToken.cacheWrite += entryTokenTotals.cacheWrite;
      utcQuarterHourToken.totalTokens += entryTokenTotals.totalTokens;
      utcQuarterHourToken.totalCost += entryCost;
      utcQuarterHourTokenMap.set(quarterBucket.key, utcQuarterHourToken);

      const existing = dailyMap.get(dayKey) ?? { tokens: 0, cost: 0 };
      dailyMap.set(dayKey, {
        tokens: existing.tokens + entryTokens,
        cost: existing.cost + entryCost,
      });

      if (entry.provider || entry.model) {
        const modelKey = `${dayKey}::${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
        const dailyModel =
          dailyModelUsageMap.get(modelKey) ??
          ({
            date: dayKey,
            provider: entry.provider,
            model: entry.model,
            tokens: 0,
            cost: 0,
            count: 0,
          } as SessionDailyModelUsage);
        dailyModel.tokens += entryTokens;
        dailyModel.cost += entryCost;
        dailyModel.count += 1;
        dailyModelUsageMap.set(modelKey, dailyModel);
      }
    }

    if (entry.provider || entry.model) {
      const key = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
      const existing =
        modelUsageMap.get(key) ??
        ({
          provider: entry.provider,
          model: entry.model,
          count: 0,
          totals: emptyTotals(),
        } as SessionModelUsage);
      existing.count += 1;
      applyUsageTotals(existing.totals, entry.usage);
      if (entry.costBreakdown?.total !== undefined) {
        applyCostBreakdown(existing.totals, entry.costBreakdown);
      } else {
        applyCostTotal(existing.totals, entry.costTotal);
      }
      modelUsageMap.set(key, existing);
    }
  }

  // Convert daily map to sorted array
  const dailyBreakdown: SessionDailyUsage[] = Array.from(dailyMap.entries())
    .map(([date, data]) => ({ date, tokens: data.tokens, cost: data.cost }))
    .toSorted((a, b) => a.date.localeCompare(b.date));

  const dailyMessageCounts: SessionDailyMessageCounts[] = Array.from(
    dailyMessageMap.values(),
  ).toSorted((a, b) => a.date.localeCompare(b.date));

  const utcQuarterHourMessageCounts: SessionUtcQuarterHourMessageCounts[] = Array.from(
    utcQuarterHourMessageMap.values(),
  ).toSorted((a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex);

  const utcQuarterHourTokenUsage: SessionUtcQuarterHourTokenUsage[] = Array.from(
    utcQuarterHourTokenMap.values(),
  ).toSorted((a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex);

  const dailyLatency: SessionDailyLatency[] = Array.from(dailyLatencyMap.entries())
    .map(([date, values]) => {
      const stats = computeLatencyStats(values);
      if (!stats) {
        return null;
      }
      return Object.assign({ date }, stats);
    })
    .filter((entry): entry is SessionDailyLatency => Boolean(entry))
    .toSorted((a, b) => a.date.localeCompare(b.date));

  const dailyModelUsage: SessionDailyModelUsage[] = Array.from(
    dailyModelUsageMap.values(),
  ).toSorted((a, b) => a.date.localeCompare(b.date) || b.cost - a.cost);

  const toolUsage: SessionToolUsage | undefined = toolUsageMap.size
    ? {
        totalCalls: Array.from(toolUsageMap.values()).reduce((sum, count) => sum + count, 0),
        uniqueTools: toolUsageMap.size,
        tools: Array.from(toolUsageMap.entries())
          .map(([name, count]) => ({ name, count }))
          .toSorted((a, b) => b.count - a.count),
      }
    : undefined;

  const modelUsage = modelUsageMap.size
    ? Array.from(modelUsageMap.values()).toSorted((a, b) => {
        const costDiff = (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0);
        if (costDiff !== 0) {
          return costDiff;
        }
        return (b.totals?.totalTokens ?? 0) - (a.totals?.totalTokens ?? 0);
      })
    : undefined;

  return {
    sessionId: params.sessionId,
    sessionFile,
    firstActivity,
    lastActivity,
    durationMs:
      firstActivity !== undefined && lastActivity !== undefined
        ? Math.max(0, lastActivity - firstActivity)
        : undefined,
    activityDates: Array.from(activityDatesSet).toSorted(),
    dailyBreakdown,
    dailyMessageCounts,
    utcQuarterHourMessageCounts: utcQuarterHourMessageCounts.length
      ? utcQuarterHourMessageCounts
      : undefined,
    utcQuarterHourTokenUsage: utcQuarterHourTokenUsage.length
      ? utcQuarterHourTokenUsage
      : undefined,
    dailyLatency: dailyLatency.length ? dailyLatency : undefined,
    dailyModelUsage: dailyModelUsage.length ? dailyModelUsage : undefined,
    messageCounts,
    toolUsage,
    modelUsage,
    latency: computeLatencyStats(latencyValues),
    ...totals,
  };
}

export async function loadSessionUsageTimeSeries(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId?: string;
  maxPoints?: number;
}): Promise<SessionUsageTimeSeries | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return null;
  }

  if (params.maxPoints !== undefined && params.maxPoints !== null) {
    if (!Number.isFinite(params.maxPoints) || params.maxPoints <= 0) {
      return { sessionId: params.sessionId, points: [] };
    }
  }

  const points: SessionUsageTimePoint[] = [];
  let cumulativeTokens = 0;
  let cumulativeCost = 0;
  const resolveCost = createUsageCostResolver(params.config);
  const usageEntries: ParsedUsageEntry[] = [];

  await scanUsageFile({
    filePath: sessionFile,
    config: params.config,
    resolveCost,
    onEntry: (entry) => {
      usageEntries.push(entry);
    },
  });

  const consumedModelCallBridgeOwnerIndexes = new Set<number>();
  const consumedModelCallBridgeIndexes = new Set<number>();
  for (const [entryIndex, entry] of usageEntries.entries()) {
    if (
      skipModelCallBridgeUsageEntry({
        entry,
        entryIndex,
        entries: usageEntries,
        consumedOwnerIndexes: consumedModelCallBridgeOwnerIndexes,
        consumedBridgeIndexes: consumedModelCallBridgeIndexes,
      })
    ) {
      continue;
    }

    const ts = entry.timestamp?.getTime();
    if (!ts) {
      continue;
    }

    const { input, output, cacheRead, cacheWrite, totalTokens } = computeUsageTokenTotals(
      entry.usage,
    );
    const cost = entry.costTotal ?? 0;

    cumulativeTokens += totalTokens;
    cumulativeCost += cost;

    points.push({
      timestamp: ts,
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost,
      cumulativeTokens,
      cumulativeCost,
    });
  }

  // Sort by timestamp
  const sortedPoints = points.toSorted((a, b) => a.timestamp - b.timestamp);

  // Optionally downsample if too many points
  const maxPoints = params.maxPoints ?? 100;
  if (sortedPoints.length > maxPoints) {
    const step = Math.ceil(sortedPoints.length / maxPoints);
    const downsampled: SessionUsageTimePoint[] = [];
    let downsampledCumulativeTokens = 0;
    let downsampledCumulativeCost = 0;
    for (let i = 0; i < sortedPoints.length; i += step) {
      const bucket = sortedPoints.slice(i, i + step);
      const bucketLast = bucket[bucket.length - 1];
      if (!bucketLast) {
        continue;
      }

      let bucketInput = 0;
      let bucketOutput = 0;
      let bucketCacheRead = 0;
      let bucketCacheWrite = 0;
      let bucketTotalTokens = 0;
      let bucketCost = 0;
      for (const point of bucket) {
        bucketInput += point.input;
        bucketOutput += point.output;
        bucketCacheRead += point.cacheRead;
        bucketCacheWrite += point.cacheWrite;
        bucketTotalTokens += point.totalTokens;
        bucketCost += point.cost;
      }

      downsampledCumulativeTokens += bucketTotalTokens;
      downsampledCumulativeCost += bucketCost;

      downsampled.push({
        timestamp: bucketLast.timestamp,
        input: bucketInput,
        output: bucketOutput,
        cacheRead: bucketCacheRead,
        cacheWrite: bucketCacheWrite,
        totalTokens: bucketTotalTokens,
        cost: bucketCost,
        cumulativeTokens: downsampledCumulativeTokens,
        cumulativeCost: downsampledCumulativeCost,
      });
    }
    return { sessionId: params.sessionId, points: downsampled };
  }

  return { sessionId: params.sessionId, points: sortedPoints };
}

export async function loadSessionLogs(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId?: string;
  limit?: number;
}): Promise<SessionLogEntry[] | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return null;
  }

  const logs: SessionLogEntry[] = [];
  if (params.limit !== undefined && params.limit !== null) {
    if (!Number.isFinite(params.limit) || params.limit <= 0) {
      return [];
    }
  }
  const limit = params.limit ?? 50;
  const boundedLimit = Number.isInteger(limit);
  const retentionLimit = limit * 2;
  const resolveCost = createUsageCostResolver(params.config);

  for await (const source of readJsonlRecords(sessionFile)) {
    try {
      const parsed = source.record;
      const message = parsed.message as Record<string, unknown> | undefined;
      if (!message) {
        continue;
      }

      const role = message.role as string | undefined;
      if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "toolResult") {
        continue;
      }

      const contentParts: string[] = [];
      const rawToolName = message.toolName ?? message.tool_name ?? message.name ?? message.tool;
      const toolName = normalizeOptionalString(rawToolName);
      if (role === "tool" || role === "toolResult") {
        contentParts.push(`[Tool: ${toolName ?? "tool"}]`);
        contentParts.push("[Tool Result]");
      }

      // Extract content
      const rawContent = message.content;
      if (typeof rawContent === "string") {
        contentParts.push(rawContent);
      } else if (Array.isArray(rawContent)) {
        // Handle content blocks (text, tool_use, etc.)
        const contentText = rawContent
          .map((block: unknown) => {
            if (typeof block === "string") {
              return block;
            }
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              return b.text;
            }
            if (b.type === "tool_use") {
              const name = typeof b.name === "string" ? b.name : "unknown";
              return `[Tool: ${name}]`;
            }
            if (b.type === "tool_result") {
              return `[Tool Result]`;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
        if (contentText) {
          contentParts.push(contentText);
        }
      }

      // OpenAI-style tool calls stored outside the content array.
      const rawToolCalls =
        message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
      const toolCalls = Array.isArray(rawToolCalls)
        ? rawToolCalls
        : rawToolCalls
          ? [rawToolCalls]
          : [];
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          const callObj = call as Record<string, unknown>;
          const directName = typeof callObj.name === "string" ? callObj.name : undefined;
          const fn = callObj.function as Record<string, unknown> | undefined;
          const fnName = typeof fn?.name === "string" ? fn.name : undefined;
          const name = directName ?? fnName ?? "unknown";
          contentParts.push(`[Tool: ${name}]`);
        }
      }

      let content = contentParts.join("\n").trim();
      if (!content) {
        continue;
      }
      content = stripInboundMetadata(content);
      if (role === "user") {
        content = stripMessageIdHints(stripEnvelope(content)).trim();
      }
      if (!content) {
        continue;
      }

      // Truncate very long content
      const maxLen = 2000;
      if (content.length > maxLen) {
        content = content.slice(0, maxLen) + "…";
      }

      // Get timestamp
      let timestamp = 0;
      if (typeof parsed.timestamp === "string") {
        timestamp = new Date(parsed.timestamp).getTime();
      } else if (typeof message.timestamp === "number") {
        timestamp = message.timestamp;
      }

      // Get usage for assistant messages
      let tokens: number | undefined;
      let cost: number | undefined;
      if (role === "assistant") {
        const usageRaw = message.usage as Record<string, unknown> | undefined;
        const usage = normalizeUsage(usageRaw);
        if (usage) {
          tokens =
            usage.total ??
            (usage.input ?? 0) +
              (usage.output ?? 0) +
              (usage.cacheRead ?? 0) +
              (usage.cacheWrite ?? 0);
          const breakdown = extractCostBreakdown(usageRaw);
          const costConfig = resolveCost({
            provider:
              (typeof message.provider === "string" ? message.provider : undefined) ??
              (typeof parsed.provider === "string" ? parsed.provider : undefined),
            model:
              (typeof message.model === "string" ? message.model : undefined) ??
              (typeof parsed.model === "string" ? parsed.model : undefined),
          });
          if (
            breakdown?.total !== undefined &&
            !shouldRecomputeRecordedZeroCost({
              usage,
              cost: costConfig,
              costBreakdown: breakdown,
              costTotal: breakdown.total,
            })
          ) {
            cost = breakdown.total;
          } else {
            cost = estimateUsageCost({ usage, cost: costConfig });
          }
        }
      }

      logs.push({
        timestamp,
        role,
        content,
        tokens,
        cost,
      });
      // Timestamps can arrive out of order, so keep a bounded sorted window instead
      // of relying on transcript append order or retaining the whole file.
      if (boundedLimit && logs.length > retentionLimit) {
        logs.sort((a, b) => a.timestamp - b.timestamp);
        logs.splice(0, logs.length - limit);
      }
    } catch {
      // Ignore malformed lines
    }
  }

  // Sort by timestamp and limit
  if (boundedLimit) {
    logs.sort((a, b) => a.timestamp - b.timestamp);
    return logs.length > limit ? logs.slice(-limit) : logs;
  }

  // Return most recent logs
  const sortedLogs = logs.toSorted((a, b) => a.timestamp - b.timestamp);
  if (sortedLogs.length > limit) {
    return sortedLogs.slice(-limit);
  }

  return sortedLogs;
}
