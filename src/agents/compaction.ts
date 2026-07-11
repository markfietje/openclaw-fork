/**
 * Summarization and fallback helpers for transcript compaction.
 */
import { randomUUID } from "node:crypto";
import { isAbortError } from "../infra/abort-signal.js";
import { appendSessionTranscriptEvent } from "../config/sessions/transcript-append.js";
import type { AgentCompactionIdentifierPolicy } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { retryAsync } from "../infra/retry.js";
import { streamSimple } from "../llm/stream.js";
import type { Usage } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  USAGE_BUDGET_RECORDED_COST_METADATA_KEY,
  USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION,
  type UsageBudgetRecordedCostMetadata,
  type UsageBudgetUnpriceableCostMetadata,
} from "../shared/usage-budget-recorded-cost.js";
import {
  buildOversizedFallbackPlanWithWorker,
  buildStageSplitPlanWithWorker,
  buildSummaryChunksWithWorker,
} from "./compaction-planning-worker.js";
import {
  BASE_CHUNK_RATIO,
  chunkMessagesByMaxTokens,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  isOversizedForSummary,
  MIN_CHUNK_RATIO,
  pruneHistoryForContextShare,
  SAFETY_MARGIN,
  splitMessagesByTokenShare,
  SUMMARIZATION_OVERHEAD_TOKENS,
} from "./compaction-planning.js";
import {
  MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE,
  USAGE_BUDGET_OPERATION_ID_KEY,
} from "./compaction-usage-accounting.js";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { isTimeoutError } from "./failover-error.js";
import {
  isModelProviderDispatchObservableStreamFn,
  resolveProviderDispatchCostMultiplierForStreamFn,
  resolveProviderDispatchModelForStreamFn,
  resolveProviderDispatchReservationCostMultiplierForStreamFn,
} from "./provider-dispatch-observable-stream.js";
import type { AgentMessage } from "./runtime/index.js";
import type { ExtensionContext } from "./sessions/index.js";
import {
  convertToLlm,
  generateSummary as agentGenerateSummary,
  generateSummaryWithUsage as agentGenerateSummaryWithUsage,
} from "./sessions/index.js";
import {
  acquireAgentUsageBudgetAdmission,
  AgentUsageBudgetError,
  buildUnsupportedAgentUsageBudgetStreamError,
  isAgentUsageBudgetError,
  recordAgentUsageBudgetAdmissionResult,
  resolveUsageBudgetCostMultiplierUsage,
  resolveAgentUsageBudgetConfig,
  type AgentUsageBudgetAdmissionRelease,
} from "./usage-budget.js";
import { hasNonzeroUsageLike } from "./usage.js";

export {
  BASE_CHUNK_RATIO,
  chunkMessagesByMaxTokens,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  isOversizedForSummary,
  MIN_CHUNK_RATIO,
  pruneHistoryForContextShare,
  SAFETY_MARGIN,
  splitMessagesByTokenShare,
  SUMMARIZATION_OVERHEAD_TOKENS,
};

const log = createSubsystemLogger("compaction");

type PartialSummaryError = Error & { partialSummary?: string };
type PartialSummaryUsageError = PartialSummaryError & { partialUsage?: Usage };
export type CompactionSummaryWithUsage = {
  summary: string;
  usage?: Usage;
};

function readCompactionRecordedCostMetadata(
  usage: Usage,
): UsageBudgetRecordedCostMetadata | undefined {
  const metadata = (usage as unknown as Record<string, unknown>)[
    USAGE_BUDGET_RECORDED_COST_METADATA_KEY
  ];
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const record = metadata as Partial<UsageBudgetRecordedCostMetadata>;
  if (
    record.schemaVersion !== USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION ||
    (record.kind !== "estimated-model-call-cost" &&
      record.kind !== "provider-billed-model-call-cost") ||
    typeof record.costMultiplier !== "number" ||
    !Number.isFinite(record.costMultiplier) ||
    record.costMultiplier <= 0
  ) {
    return undefined;
  }
  return {
    schemaVersion: USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION,
    kind: record.kind,
    costMultiplier: record.costMultiplier,
  };
}

function readCompactionUnpriceableCostMetadata(
  usage: Usage,
): UsageBudgetUnpriceableCostMetadata | undefined {
  const metadata = (usage as unknown as Record<string, unknown>)[
    USAGE_BUDGET_RECORDED_COST_METADATA_KEY
  ];
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const record = metadata as Partial<UsageBudgetUnpriceableCostMetadata>;
  if (
    record.schemaVersion !== USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION ||
    record.kind !== "unpriceable-model-call-cost" ||
    (record.reason !== "capacity-billed-service-tier" &&
      record.reason !== "provider-billed-cost-unavailable" &&
      record.reason !== "unknown-service-tier")
  ) {
    return undefined;
  }
  return {
    schemaVersion: USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION,
    kind: "unpriceable-model-call-cost",
    reason: record.reason,
  };
}

function compactionUsageHasTokens(usage: Usage): boolean {
  return (
    usage.totalTokens > 0 ||
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0
  );
}

function compactionUsageHasCompleteCostEvidence(usage: Usage): boolean {
  return (
    readCompactionRecordedCostMetadata(usage) !== undefined ||
    readCompactionUnpriceableCostMetadata(usage) !== undefined ||
    usage.cost.total > 0
  );
}

function compactionUsageHasIncompleteCostEvidence(usage: Usage): boolean {
  return compactionUsageHasTokens(usage) && !compactionUsageHasCompleteCostEvidence(usage);
}

function mergeCompactionCostMetadata(
  left: Usage,
  right: Usage,
): UsageBudgetRecordedCostMetadata | UsageBudgetUnpriceableCostMetadata | undefined {
  const leftUnpriceableMetadata = readCompactionUnpriceableCostMetadata(left);
  const rightUnpriceableMetadata = readCompactionUnpriceableCostMetadata(right);
  if (leftUnpriceableMetadata || rightUnpriceableMetadata) {
    const reason =
      leftUnpriceableMetadata?.reason === "capacity-billed-service-tier" ||
      rightUnpriceableMetadata?.reason === "capacity-billed-service-tier"
        ? "capacity-billed-service-tier"
        : leftUnpriceableMetadata?.reason === "provider-billed-cost-unavailable" ||
            rightUnpriceableMetadata?.reason === "provider-billed-cost-unavailable"
          ? "provider-billed-cost-unavailable"
          : "unknown-service-tier";
    return {
      schemaVersion: USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION,
      kind: "unpriceable-model-call-cost",
      reason,
    };
  }
  const leftMetadata = readCompactionRecordedCostMetadata(left);
  const rightMetadata = readCompactionRecordedCostMetadata(right);
  const leftTrusted = leftMetadata !== undefined || left.cost.total > 0;
  const rightTrusted = rightMetadata !== undefined || right.cost.total > 0;
  if (!leftTrusted || !rightTrusted) {
    return undefined;
  }
  if (
    leftMetadata &&
    rightMetadata &&
    leftMetadata.kind === rightMetadata.kind &&
    leftMetadata.costMultiplier === rightMetadata.costMultiplier
  ) {
    return leftMetadata;
  }
  // Mixed service tiers do not have one truthful multiplier, but the summed
  // cost is still the provider-recorded aggregate cost to preserve.
  return {
    schemaVersion: USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION,
    kind: "estimated-model-call-cost",
    costMultiplier: 1,
  };
}

const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const MERGE_SUMMARIES_INSTRUCTIONS = [
  "Merge these partial summaries into a single cohesive summary.",
  "",
  "MUST PRESERVE:",
  "- Active tasks and their current status (in-progress, blocked, pending)",
  "- Batch operation progress (e.g., '5/17 items completed')",
  "- The last thing the user requested and what was being done about it",
  "- Decisions made and their rationale",
  "- TODOs, open questions, and constraints",
  "- Any commitments or follow-ups promised",
  "",
  "PRIORITIZE recent context over older history. The agent needs to know",
  "what it was doing, not just what was discussed.",
].join("\n");
const IDENTIFIER_PRESERVATION_INSTRUCTIONS =
  "Preserve all opaque identifiers exactly as written (no shortening or reconstruction), " +
  "including UUIDs, hashes, IDs, hostnames, IPs, ports, URLs, and file names.";

/** Optional instruction policy for preserving identifiers during compaction. */
export type CompactionSummarizationInstructions = {
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  identifierInstructions?: string;
};

type GenerateSummaryCompat = {
  (
    currentMessages: AgentMessage[],
    model: NonNullable<ExtensionContext["model"]>,
    reserveTokens: number,
    apiKey: string,
    signal?: AbortSignal,
    customInstructions?: string,
    previousSummary?: string,
    onProviderDispatch?: () => void,
  ): Promise<string>;
  (
    currentMessages: AgentMessage[],
    model: NonNullable<ExtensionContext["model"]>,
    reserveTokens: number,
    apiKey: string,
    headers: Record<string, string> | undefined,
    signal?: AbortSignal,
    customInstructions?: string,
    previousSummary?: string,
    onProviderDispatch?: () => void,
  ): Promise<string>;
};

const generateSummaryCompat = agentGenerateSummary as unknown as GenerateSummaryCompat;

export function mergeCompactionSummaryUsage(
  left: Usage | undefined,
  right: Usage | undefined,
): Usage | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const merged: Usage = {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
  const metadata = mergeCompactionCostMetadata(left, right);
  if (metadata) {
    (merged as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY] =
      metadata;
  }
  if (
    compactionUsageHasIncompleteCostEvidence(left) ||
    compactionUsageHasIncompleteCostEvidence(right)
  ) {
    // A positive partial aggregate would be trusted as complete recorded spend.
    // Zero it so budget/reporting either reprices all tokens or fails closed.
    merged.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  }
  return merged;
}

function resolveIdentifierPreservationInstructions(
  instructions?: CompactionSummarizationInstructions,
): string | undefined {
  const policy = instructions?.identifierPolicy ?? "strict";
  if (policy === "off") {
    return undefined;
  }
  if (policy === "custom") {
    const custom = instructions?.identifierInstructions?.trim();
    return custom && custom.length > 0 ? custom : IDENTIFIER_PRESERVATION_INSTRUCTIONS;
  }
  return IDENTIFIER_PRESERVATION_INSTRUCTIONS;
}

/** Combines identifier-preservation and caller-provided compaction instructions. */
export function buildCompactionSummarizationInstructions(
  customInstructions?: string,
  instructions?: CompactionSummarizationInstructions,
): string | undefined {
  const custom = customInstructions?.trim();
  const identifierPreservation = resolveIdentifierPreservationInstructions(instructions);
  if (!identifierPreservation && !custom) {
    return undefined;
  }
  if (!custom) {
    return identifierPreservation;
  }
  if (!identifierPreservation) {
    return `Additional focus:\n${custom}`;
  }
  return `${identifierPreservation}\n\nAdditional focus:\n${custom}`;
}

function readCompactionErrorUsage(error: unknown): Usage | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return (
    (error as { partialUsage?: Usage }).partialUsage ??
    (error as { usage?: Usage; partialUsage?: Usage }).usage
  );
}

function buildRepeatedCompactionDispatchBudgetError(params: {
  agentId?: string | null;
  provider: string;
  model: string;
}): AgentUsageBudgetError {
  return new AgentUsageBudgetError(
    `Usage budget blocked for agent "${params.agentId ?? "unknown"}": provider retry dispatch cannot be safely attributed.`,
    {
      agentId: params.agentId ?? "unknown",
      provider: params.provider,
      model: params.model,
      harnessId: "provider-retry",
      reason: "unsupported_harness",
    },
  );
}

function isProviderRetryUsageBudgetError(error: unknown): boolean {
  return (
    isAgentUsageBudgetError(error) &&
    typeof error === "object" &&
    error !== null &&
    (error as { details?: { harnessId?: unknown } }).details?.harnessId === "provider-retry"
  );
}

function attachPartialSummaryUsage<T>(error: T, usage: Usage | undefined): T {
  if (!usage || typeof error !== "object" || error === null) {
    return error;
  }
  const carrier = error as unknown as PartialSummaryUsageError;
  carrier.partialUsage = mergeCompactionSummaryUsage(carrier.partialUsage, usage);
  return error;
}

async function summarizeChunksWithUsage(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
  previousSummary?: string;
  config?: OpenClawConfig;
  agentId?: string | null;
  transcriptPath?: string;
  usageBudgetOperationId?: string;
  onProviderCallStart?: () => void;
}): Promise<CompactionSummaryWithUsage> {
  if (params.messages.length === 0) {
    return { summary: params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK };
  }

  const chunks = await buildSummaryChunksWithWorker({
    messages: params.messages,
    maxChunkTokens: params.maxChunkTokens,
    signal: params.signal,
  });
  let summary = params.previousSummary;
  const effectiveInstructions = buildCompactionSummarizationInstructions(
    params.customInstructions,
    params.summarizationInstructions,
  );
  let hasGeneratedChunk = false;
  let usage: Usage | undefined;
  for (const chunk of chunks) {
    let failedAttemptUsage: Usage | undefined;
    try {
      const chunkSummary = await retryAsync(
        async () => {
          try {
            return await generateSummaryWithUsage(
              chunk,
              params.model,
              params.reserveTokens,
              params.apiKey,
              params.headers,
              params.signal,
              effectiveInstructions,
              summary,
              params.config,
              params.agentId,
              params.transcriptPath,
              params.usageBudgetOperationId,
              params.onProviderCallStart,
            );
          } catch (err) {
            failedAttemptUsage = mergeCompactionSummaryUsage(
              failedAttemptUsage,
              readCompactionErrorUsage(err),
            );
            throw err;
          }
        },
        {
          attempts: 3,
          minDelayMs: 500,
          maxDelayMs: 5000,
          jitter: 0.2,
          label: "compaction/generateSummary",
          shouldRetry: (err) => {
            if (isAgentUsageBudgetError(err)) {
              return false;
            }
            // Stop retrying when the caller explicitly cancelled.
            if (params.signal.aborted) {
              return false;
            }
            // Preserve existing non-retry policy for real network/transport
            // timeouts (e.g. "fetch failed", ETIMEDOUT) that are not AbortErrors.
            if (!isAbortError(err) && isTimeoutError(err)) {
              return false;
            }
            // Provider-side AbortErrors with signal not yet aborted are
            // transient disconnects — retrying is correct.
            return true;
          },
        },
      );
      summary = chunkSummary.summary;
      usage = mergeCompactionSummaryUsage(usage, failedAttemptUsage);
      usage = mergeCompactionSummaryUsage(usage, chunkSummary.usage);
      hasGeneratedChunk = true;
    } catch (err) {
      const chunkAttemptUsage = failedAttemptUsage ?? readCompactionErrorUsage(err);
      if (isAgentUsageBudgetError(err)) {
        throw attachPartialSummaryUsage(err, mergeCompactionSummaryUsage(usage, chunkAttemptUsage));
      }
      // Propagate only when the caller explicitly cancelled. Provider-side
      // AbortErrors (signal not aborted) fall through to partial/fallback paths.
      if (params.signal.aborted) {
        throw attachPartialSummaryUsage(err, mergeCompactionSummaryUsage(usage, chunkAttemptUsage));
      }
      // Real non-abort transport timeouts still propagate immediately.
      if (!isAbortError(err) && isTimeoutError(err)) {
        throw attachPartialSummaryUsage(err, mergeCompactionSummaryUsage(usage, chunkAttemptUsage));
      }
      // No chunk has succeeded yet — rethrow so summarizeWithFallback
      // can run its existing "Context contained N messages" fallback.
      if (!hasGeneratedChunk) {
        throw attachPartialSummaryUsage(err, chunkAttemptUsage);
      }
      // At least one chunk succeeded — throw with the partial summary
      // attached so summarizeWithFallback can try the oversized-message
      // retry first and only fall back to the partial summary if that
      // also fails.
      const completedChunks = chunks.indexOf(chunk);
      log.warn("chunk summarization failed after retries; partial summary available", {
        err,
        completedChunks,
        totalChunks: chunks.length,
      });
      const partial = new Error("partial summarization failure");
      (partial as PartialSummaryError).partialSummary =
        `${summary!}\n\n[Partial summary: chunks 1-${completedChunks} of ${chunks.length} were summarized. Chunks ${completedChunks + 1}-${chunks.length} could not be processed.]`;
      (partial as PartialSummaryUsageError).partialUsage = mergeCompactionSummaryUsage(
        usage,
        chunkAttemptUsage,
      );
      throw partial;
    }
  }

  return { summary: summary ?? DEFAULT_SUMMARY_FALLBACK, usage };
}

async function generateSummaryWithUsage(
  currentMessages: AgentMessage[],
  model: NonNullable<ExtensionContext["model"]>,
  reserveTokens: number,
  apiKey: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  config?: OpenClawConfig,
  agentId?: string | null,
  transcriptPath?: string,
  usageBudgetOperationId?: string,
  onProviderCallStart?: () => void,
): Promise<CompactionSummaryWithUsage> {
  let usageBudgetTimestampMs: number | undefined;
  let releaseUsageBudgetAdmission: AgentUsageBudgetAdmissionRelease | undefined;
  let usageBudgetResultRecorded = false;
  let preserveInFlightUsageBudgetAdmission = false;
  let providerDispatchStarted = false;
  const usageBudgetConfig = resolveAgentUsageBudgetConfig({ config, agentId });
  const usageBudgetDispatchContext = { messages: convertToLlm(currentMessages) };
  const usageBudgetSummaryMaxTokens = Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const usageBudgetStreamOptions = {
    maxTokens: usageBudgetSummaryMaxTokens,
    apiKey,
    headers,
    signal,
    ...(usageBudgetConfig ? { maxRetries: 0 } : {}),
    ...(usageBudgetOperationId ? { usageBudgetOperationId } : {}),
  };
  const usageBudgetDispatchModel = usageBudgetConfig
    ? resolveProviderDispatchModelForStreamFn({
        streamFn: streamSimple,
        model,
        context: usageBudgetDispatchContext,
        options: usageBudgetStreamOptions,
      })
    : model;
  const usageBudgetDispatchProvider = usageBudgetDispatchModel.provider;
  const usageBudgetDispatchModelId = usageBudgetDispatchModel.id;
  const usageBudgetCostMultiplier = usageBudgetConfig
    ? resolveProviderDispatchCostMultiplierForStreamFn({
        streamFn: streamSimple,
        model,
        context: usageBudgetDispatchContext,
        options: usageBudgetStreamOptions,
      })
    : 1;
  const usageBudgetReservationCostMultiplier = usageBudgetConfig
    ? resolveProviderDispatchReservationCostMultiplierForStreamFn({
        streamFn: streamSimple,
        model,
        context: usageBudgetDispatchContext,
        options: usageBudgetStreamOptions,
      })
    : 1;
  const onProviderDispatch = () => {
    if (providerDispatchStarted && usageBudgetConfig) {
      throw buildRepeatedCompactionDispatchBudgetError({
        agentId,
        provider: model.provider,
        model: model.id,
      });
    }
    providerDispatchStarted = true;
    onProviderCallStart?.();
  };
  if (
    usageBudgetConfig &&
    !isModelProviderDispatchObservableStreamFn({ streamFn: streamSimple, model })
  ) {
    throw buildUnsupportedAgentUsageBudgetStreamError({
      agentId,
      provider: model.provider,
      model: model.id,
    });
  }
  const recordAndPersistUsage = async (
    usage: Usage | undefined,
    stopReason: "stop" | "error",
  ): Promise<void> => {
    if (!releaseUsageBudgetAdmission || usageBudgetTimestampMs === undefined) {
      return;
    }
    const timestampMs = usageBudgetTimestampMs;
    const recordId = `compaction-summary:${timestampMs}:${randomUUID()}`;
    const recordedUsage = resolveUsageBudgetCostMultiplierUsage({
      config,
      provider: usageBudgetDispatchProvider,
      model: usageBudgetDispatchModelId,
      usage,
      costMultiplier: usageBudgetCostMultiplier,
    }) as Usage | undefined;
    try {
      recordAgentUsageBudgetAdmissionResult({
        config,
        agentId,
        provider: usageBudgetDispatchProvider,
        model: usageBudgetDispatchModelId,
        usage: recordedUsage,
        timestampMs,
        recordId,
        usageBudgetBridge: true,
        ...(usageBudgetOperationId ? { usageBudgetOperationId } : {}),
      });
      usageBudgetResultRecorded = true;
    } catch (error) {
      preserveInFlightUsageBudgetAdmission = true;
      throw error;
    }
    try {
      await appendCompactionModelCallUsageAccounting({
        config,
        transcriptPath,
        recordId,
        provider: usageBudgetDispatchProvider,
        model: usageBudgetDispatchModelId,
        api: model.api,
        usage: recordedUsage,
        stopReason,
        timestampMs,
        ...(usageBudgetOperationId ? { usageBudgetOperationId } : {}),
      });
    } catch (error) {
      log.warn(
        `failed to persist compaction usage accounting transcript: ${formatErrorMessage(error)}`,
      );
    }
  };
  try {
    releaseUsageBudgetAdmission = await acquireAgentUsageBudgetAdmission({
      config,
      agentId,
      provider: usageBudgetDispatchProvider,
      model: usageBudgetDispatchModelId,
      transcriptPath,
      reservation: {
        inputTokens: estimateMessagesTokens(currentMessages),
        outputTokens: reserveTokens,
      },
      costMultiplier: usageBudgetReservationCostMultiplier,
      reservationCostKnown: usageBudgetReservationCostMultiplier !== undefined,
      ...(usageBudgetOperationId ? { usageBudgetOperationId } : {}),
      signal,
    });
    usageBudgetTimestampMs = releaseUsageBudgetAdmission?.timestampMs;
    if (agentGenerateSummaryWithUsage) {
      const result = await agentGenerateSummaryWithUsage(
        currentMessages,
        model,
        reserveTokens,
        apiKey,
        headers,
        signal,
        customInstructions,
        previousSummary,
        undefined,
        undefined,
        undefined,
        usageBudgetOperationId,
        onProviderDispatch,
        Boolean(usageBudgetConfig),
      );
      await recordAndPersistUsage(result.usage, "stop");
      return result;
    }
    let summary: string;
    if (agentGenerateSummary.length >= 8) {
      summary = await generateSummaryCompat(
        currentMessages,
        model,
        reserveTokens,
        apiKey,
        headers,
        signal,
        customInstructions,
        previousSummary,
        onProviderDispatch,
      );
    } else {
      summary = await generateSummaryCompat(
        currentMessages,
        model,
        reserveTokens,
        apiKey,
        signal,
        customInstructions,
        previousSummary,
        onProviderDispatch,
      );
    }
    await recordAndPersistUsage(undefined, "stop");
    return { summary };
  } catch (error) {
    const errorUsage = readCompactionErrorUsage(error);
    if (
      releaseUsageBudgetAdmission &&
      !usageBudgetResultRecorded &&
      (!isAgentUsageBudgetError(error) || isProviderRetryUsageBudgetError(error)) &&
      (providerDispatchStarted || hasNonzeroUsageLike(errorUsage))
    ) {
      await recordAndPersistUsage(errorUsage, "error");
    }
    throw error;
  } finally {
    await releaseUsageBudgetAdmission?.({
      preserveInFlight: preserveInFlightUsageBudgetAdmission,
    });
  }
}

async function appendCompactionModelCallUsageAccounting(params: {
  config?: OpenClawConfig;
  transcriptPath?: string;
  recordId: string;
  provider: string;
  model: string;
  api?: string;
  usage: Usage | undefined;
  stopReason: "stop" | "error";
  timestampMs: number;
  usageBudgetOperationId?: string;
}): Promise<void> {
  if (!params.transcriptPath) {
    return;
  }
  await appendSessionTranscriptEvent({
    config: params.config,
    transcriptPath: params.transcriptPath,
    event: {
      type: "custom",
      customType: MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE,
      id: params.recordId,
      parentId: null,
      timestamp: new Date(params.timestampMs).toISOString(),
      appendMode: "side",
      data: {
        schemaVersion: 1,
        usageBudgetBridge: true,
        ...(params.usageBudgetOperationId
          ? { [USAGE_BUDGET_OPERATION_ID_KEY]: params.usageBudgetOperationId }
          : {}),
        message: {
          role: "assistant",
          content: [],
          ...(params.api ? { api: params.api } : {}),
          provider: params.provider,
          model: params.model,
          usage: params.usage,
          stopReason: params.stopReason,
          timestamp: params.timestampMs,
        },
      },
    },
  });
}

/**
 * Summarize with progressive fallback for handling oversized messages.
 * If full summarization fails, tries partial summarization excluding oversized messages.
 */
export async function summarizeWithFallback(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
  previousSummary?: string;
}): Promise<string> {
  return (await summarizeWithFallbackWithUsage(params)).summary;
}

export async function summarizeWithFallbackWithUsage(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
  previousSummary?: string;
  config?: OpenClawConfig;
  agentId?: string | null;
  transcriptPath?: string;
  usageBudgetOperationId?: string;
  onProviderCallStart?: () => void;
}): Promise<CompactionSummaryWithUsage> {
  const { messages, contextWindow } = params;

  if (messages.length === 0) {
    return { summary: params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK };
  }

  // Try full summarization first
  let partialSummaryFallback: string | undefined;
  let partialUsageFallback: Usage | undefined;
  try {
    return await summarizeChunksWithUsage(params);
  } catch (fullError) {
    if (isAgentUsageBudgetError(fullError)) {
      throw fullError;
    }
    if (params.signal.aborted) {
      throw fullError;
    }
    log.warn(`Full summarization failed: ${formatErrorMessage(fullError)}`);
    partialSummaryFallback = (fullError as PartialSummaryError).partialSummary;
    partialUsageFallback = (fullError as PartialSummaryUsageError).partialUsage;
  }

  // Fallback 1: Summarize only small messages, note oversized ones.
  const { smallMessages, oversizedNotes } = await buildOversizedFallbackPlanWithWorker({
    messages,
    contextWindow,
    signal: params.signal,
  });

  // When nothing was oversized, `smallMessages` is the same transcript as the full attempt.
  // Re-summarizing it would duplicate the same failing API work (and duplicate warn logs).
  if (smallMessages.length > 0 && smallMessages.length !== messages.length) {
    try {
      const partialSummary = await summarizeChunksWithUsage({
        ...params,
        messages: smallMessages,
      });
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
      return {
        summary: partialSummary.summary + notes,
        usage: mergeCompactionSummaryUsage(partialUsageFallback, partialSummary.usage),
      };
    } catch (partialError) {
      if (isAgentUsageBudgetError(partialError)) {
        throw partialError;
      }
      if (params.signal.aborted) {
        throw partialError;
      }
      log.warn(`Partial summarization also failed: ${formatErrorMessage(partialError)}`);
      // Prefer the oversized retry's partial summary over the full attempt's,
      // since it covers the non-oversized transcript. Append oversized notes
      // so the model knows large content was filtered.
      const retryPartial = (partialError as PartialSummaryError).partialSummary;
      partialUsageFallback = mergeCompactionSummaryUsage(
        partialUsageFallback,
        (partialError as PartialSummaryUsageError).partialUsage,
      );
      if (retryPartial) {
        const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
        partialSummaryFallback = retryPartial + notes;
      }
    }
  }

  // Final fallback: use best available partial summary, otherwise generic note
  if (partialSummaryFallback) {
    return { summary: partialSummaryFallback, usage: partialUsageFallback };
  }
  return {
    summary:
      `Context contained ${messages.length} messages (${oversizedNotes.length} oversized). ` +
      `Summary unavailable due to size limits.`,
    usage: partialUsageFallback,
  };
}

/** Summarizes history in multiple stages when a single pass would be too large. */
export async function summarizeInStages(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
  previousSummary?: string;
  parts?: number;
  minMessagesForSplit?: number;
}): Promise<string> {
  return (await summarizeInStagesWithUsage(params)).summary;
}

export async function summarizeInStagesWithUsage(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
  previousSummary?: string;
  parts?: number;
  minMessagesForSplit?: number;
  config?: OpenClawConfig;
  agentId?: string | null;
  transcriptPath?: string;
  onProviderCallStart?: () => void;
}): Promise<CompactionSummaryWithUsage> {
  const { messages } = params;
  if (messages.length === 0) {
    return { summary: params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK };
  }

  const plan = await buildStageSplitPlanWithWorker({
    messages,
    maxChunkTokens: params.maxChunkTokens,
    parts: params.parts,
    minMessagesForSplit: params.minMessagesForSplit,
    signal: params.signal,
  });

  if (plan.mode === "single") {
    return summarizeWithFallbackWithUsage(params);
  }

  const partialSummaries: string[] = [];
  let usage: Usage | undefined;
  for (const chunk of plan.chunks) {
    let partial: CompactionSummaryWithUsage;
    try {
      partial = await summarizeWithFallbackWithUsage({
        ...params,
        messages: chunk,
        previousSummary: undefined,
      });
    } catch (err) {
      throw attachPartialSummaryUsage(err, usage);
    }
    partialSummaries.push(partial.summary);
    usage = mergeCompactionSummaryUsage(usage, partial.usage);
  }

  if (partialSummaries.length === 1) {
    return { summary: partialSummaries[0] ?? DEFAULT_SUMMARY_FALLBACK, usage };
  }

  const summaryMessages: AgentMessage[] = partialSummaries.map((summary) => ({
    role: "user",
    content: summary,
    timestamp: Date.now(),
  }));

  const custom = params.customInstructions?.trim();
  const mergeInstructions = custom
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\n${custom}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  let merged: CompactionSummaryWithUsage;
  try {
    merged = await summarizeWithFallbackWithUsage({
      ...params,
      messages: summaryMessages,
      customInstructions: mergeInstructions,
    });
  } catch (err) {
    throw attachPartialSummaryUsage(err, usage);
  }
  return {
    summary: merged.summary,
    usage: mergeCompactionSummaryUsage(usage, merged.usage),
  };
}

/** Resolves a positive context-window token count from model metadata. */
export function resolveContextWindowTokens(model?: ExtensionContext["model"]): number {
  const effective =
    (model as { contextTokens?: number } | undefined)?.contextTokens ?? model?.contextWindow;
  return Math.max(1, Math.floor(effective ?? DEFAULT_CONTEXT_TOKENS));
}
