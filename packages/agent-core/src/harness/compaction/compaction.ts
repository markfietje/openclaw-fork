// Agent Core module implements compaction behavior.
import {
  resolveClaudeFable5ModelIdentity,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamFn,
  type Usage,
} from "../../../../llm-core/src/index.js";
import { resolveAgentReasoningOption } from "../../reasoning.js";
import {
  type AgentCoreCompletionRuntimeDeps,
  resolveAgentCoreCompleteFn,
} from "../../runtime-deps.js";
import type { AgentMessage, ThinkingLevel } from "../../types.js";
import {
  asAgentMessage,
  convertToLlm,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
  type HarnessMessage,
} from "../messages.js";
import { buildSessionContext } from "../session/session.js";
import { uuidv7 } from "../session/uuid.js";
import {
  type CompactionEntry,
  CompactionError,
  err,
  ok,
  type Result,
  type SessionTreeEntry,
} from "../types.js";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  type FileOperations,
  formatFileOperations,
  getCompactionContentBlockText,
  serializeConversation,
} from "./utils.js";

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails {
  /** Files read in the compacted history. */
  readFiles: string[];
  /** Files modified in the compacted history. */
  modifiedFiles: string[];
}
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function extractFileOperations(
  messages: AgentMessage[],
  entries: SessionTreeEntry[],
  prevCompactionIndex: number,
): FileOperations {
  const fileOps = createFileOps();
  if (prevCompactionIndex >= 0) {
    const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
    if (!prevCompaction.fromHook && prevCompaction.details) {
      const details = prevCompaction.details as CompactionDetails;
      if (Array.isArray(details.readFiles)) {
        for (const f of details.readFiles) {
          fileOps.read.add(f);
        }
      }
      if (Array.isArray(details.modifiedFiles)) {
        for (const f of details.modifiedFiles) {
          fileOps.edited.add(f);
        }
      }
    }
  }
  for (const msg of messages) {
    extractFileOpsFromMessage(msg, fileOps);
  }

  return fileOps;
}
function getMessageFromEntry(entry: SessionTreeEntry): AgentMessage | undefined {
  if (entry.type === "message") {
    return entry.message;
  }
  if (entry.type === "custom_message") {
    return asAgentMessage(
      createCustomMessage(
        entry.customType,
        entry.content,
        entry.display,
        entry.details,
        entry.timestamp,
      ),
    );
  }
  if (entry.type === "branch_summary") {
    return asAgentMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
  }
  if (entry.type === "compaction") {
    return asAgentMessage(
      createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
    );
  }
  return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionTreeEntry): AgentMessage | undefined {
  if (entry.type === "compaction") {
    return undefined;
  }
  return getMessageFromEntry(entry);
}

/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactionResult<T = unknown> {
  /** Summary text that replaces compacted history in future context. */
  summary: string;
  /** Entry id where retained history starts. */
  firstKeptEntryId: string;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Provider-reported usage for the summarization call(s), when available. */
  usage?: Usage;
  /** Internal accounting operation id for reconciling aggregate and per-call usage rows. */
  usageBudgetOperationId?: string;
  /** Optional implementation-specific details stored with the compaction entry. */
  details?: T;
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
  /** Enable automatic compaction decisions. */
  enabled: boolean;
  /** Tokens reserved for summary prompt and output. */
  reserveTokens: number;
  /** Approximate recent-context tokens to keep after compaction. */
  keepRecentTokens: number;
}

/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  if (msg.role === "assistant" && "usage" in msg) {
    const assistantMsg = msg;
    if (
      assistantMsg.stopReason !== "aborted" &&
      assistantMsg.stopReason !== "error" &&
      assistantMsg.usage
    ) {
      return assistantMsg.usage;
    }
  }
  return undefined;
}

/** Return usage from the last successful assistant message in session entries. */
export function getLastAssistantUsage(entries: SessionTreeEntry[]): Usage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message") {
      const usage = getAssistantUsage(entry.message);
      if (usage) {
        return usage;
      }
    }
  }
  return undefined;
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
  /** Estimated total context tokens. */
  tokens: number;
  /** Tokens reported by the most recent assistant usage block. */
  usageTokens: number;
  /** Estimated tokens after the most recent assistant usage block. */
  trailingTokens: number;
  /** Index of the message that provided usage, or null when none exists. */
  lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(
  messages: AgentMessage[],
): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) {
      return { usage, index: i };
    }
  }
  return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages);

  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateTokens(message);
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }

  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) {
    return false;
  }
  return contextTokens > contextWindow - settings.reserveTokens;
}

const IMAGE_BLOCK_CHARS = 4800;

function countContentBlockChars(
  content: Array<{ type: string; content?: unknown; text?: string }>,
): number {
  let chars = 0;
  for (const block of content) {
    if (block.type === "image") {
      chars += IMAGE_BLOCK_CHARS;
    } else {
      chars += getCompactionContentBlockText(block).length;
    }
  }
  return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;
  const harnessMessage = message as HarnessMessage;

  switch (harnessMessage.role) {
    case "user": {
      const content = (
        harnessMessage as { content: string | Array<{ type: string; text?: string }> }
      ).content;
      if (typeof content === "string") {
        chars = content.length;
      } else if (Array.isArray(content)) {
        chars = countContentBlockChars(content);
      }
      return Math.ceil(chars / 4);
    }
    case "assistant": {
      const assistant = harnessMessage;
      for (const block of assistant.content) {
        if (block.type === "text") {
          chars += block.text.length;
        } else if (block.type === "thinking") {
          chars += block.thinking.length;
        } else if (block.type === "toolCall") {
          chars += block.name.length + safeJsonStringify(block.arguments).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case "custom":
    case "toolResult": {
      if (typeof harnessMessage.content === "string") {
        chars = harnessMessage.content.length;
      } else {
        chars = countContentBlockChars(harnessMessage.content);
      }
      return Math.ceil(chars / 4);
    }
    case "bashExecution": {
      chars = harnessMessage.command.length + harnessMessage.output.length;
      return Math.ceil(chars / 4);
    }
    case "branchSummary":
    case "compactionSummary": {
      chars = harnessMessage.summary.length;
      return Math.ceil(chars / 4);
    }
  }

  return 0;
}
function findValidCutPoints(
  entries: SessionTreeEntry[],
  startIndex: number,
  endIndex: number,
): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    switch (entry.type) {
      case "message": {
        const role = (entry.message as HarnessMessage).role;
        switch (role) {
          case "bashExecution":
          case "custom":
          case "branchSummary":
          case "compactionSummary":
          case "user":
          case "assistant":
            cutPoints.push(i);
            break;
          case "toolResult":
            break;
        }
        break;
      }
      case "thinking_level_change":
      case "model_change":
      case "compaction":
      case "branch_summary":
      case "custom":
      case "custom_message":
      case "label":
      case "session_info":
      case "leaf":
        break;
    }
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      cutPoints.push(i);
    }
  }
  return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(
  entries: SessionTreeEntry[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      return i;
    }
    if (entry.type === "message") {
      const role = (entry.message as HarnessMessage).role;
      if (role === "user" || role === "bashExecution") {
        return i;
      }
    }
  }
  return -1;
}

/** Cut point selected for compaction. */
export interface CutPointResult {
  /** Index of the first entry retained after compaction. */
  firstKeptEntryIndex: number;
  /** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
  turnStartIndex: number;
  /** Whether the selected cut point splits an in-progress turn. */
  isSplitTurn: boolean;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
  entries: SessionTreeEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0];

  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type !== "message") {
      continue;
    }
    const messageTokens = estimateTokens(entry.message);
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      cutIndex = cutPoints[cutPoints.length - 1];
      for (const cutPoint of cutPoints) {
        if (cutPoint >= i) {
          cutIndex = cutPoint;
          break;
        }
      }
      break;
    }
  }
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    if (prevEntry.type === "compaction") {
      break;
    }
    if (prevEntry.type === "message") {
      break;
    }
    cutIndex--;
  }
  const cutEntry = entries[cutIndex];
  const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function createSummarizationOptions(
  model: Model,
  maxTokens: number,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  onProviderDispatch?: () => void,
  disableProviderRetries = false,
): SimpleStreamOptions {
  const options: SimpleStreamOptions = {
    maxTokens,
    signal,
    apiKey,
    headers,
    ...(disableProviderRetries ? { maxRetries: 0 } : {}),
    ...(onProviderDispatch ? { onProviderDispatch } : {}),
  };
  const fableReasoning =
    (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") &&
    resolveClaudeFable5ModelIdentity(model) !== undefined;
  if ((model.reasoning || fableReasoning) && thinkingLevel) {
    options.reasoning = resolveAgentReasoningOption(model, thinkingLevel);
  }
  return options;
}

async function completeSummarization(
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
  usageBudgetOperationId?: string,
): Promise<AssistantMessage> {
  if (streamFn) {
    const streamOptions = usageBudgetOperationId ? { ...options, usageBudgetOperationId } : options;
    return (await streamFn(model, context, streamOptions)).result();
  }
  const completeOptions = usageBudgetOperationId ? { ...options, usageBudgetOperationId } : options;
  return await resolveAgentCoreCompleteFn(runtime)(model, context, completeOptions);
}

export type GeneratedSummary = {
  summary: string;
  usage?: Usage;
};

const USAGE_BUDGET_RECORDED_COST_METADATA_KEY = "usageBudgetRecordedCost";
const USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION = 1;

type UsageBudgetRecordedCostMetadata = {
  schemaVersion: typeof USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION;
  kind: "estimated-model-call-cost" | "provider-billed-model-call-cost";
  costMultiplier: number;
};

type UsageBudgetUnpriceableCostMetadata = {
  schemaVersion: typeof USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION;
  kind: "unpriceable-model-call-cost";
  reason:
    | "capacity-billed-service-tier"
    | "provider-billed-cost-unavailable"
    | "unknown-service-tier";
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

function mergeUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
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

function withCompactionErrorUsage(
  error: CompactionError,
  usage: Usage | undefined,
  usageBudgetOperationId?: string,
): CompactionError {
  if (!usage) {
    if (error.usage && usageBudgetOperationId) {
      error.usageBudgetOperationId = usageBudgetOperationId;
    }
    return error;
  }
  error.usage = mergeUsage(error.usage, usage);
  if (usageBudgetOperationId) {
    error.usageBudgetOperationId = usageBudgetOperationId;
  }
  return error;
}

function withCompactionErrorUsageBudgetOperationId(
  error: CompactionError,
  usageBudgetOperationId: string,
): CompactionError {
  if (error.usage) {
    error.usageBudgetOperationId = usageBudgetOperationId;
  }
  return error;
}

export async function generateSummaryWithUsage(
  currentMessages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
  usageBudgetOperationId?: string,
  onProviderDispatch?: () => void,
  disableProviderRetries?: boolean,
): Promise<Result<GeneratedSummary, CompactionError>> {
  const maxTokens = Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }
  const llmMessages = convertToLlm(currentMessages);
  const conversationText = serializeConversation(llmMessages);
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  const summarizationMessages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: promptText }],
      timestamp: Date.now(),
    },
  ];

  const response = await completeSummarization(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
    createSummarizationOptions(
      model,
      maxTokens,
      apiKey,
      headers,
      signal,
      thinkingLevel,
      onProviderDispatch,
      disableProviderRetries,
    ),
    streamFn,
    runtime,
    usageBudgetOperationId,
  );
  if (response.stopReason === "aborted") {
    return err(
      new CompactionError(
        "aborted",
        response.errorMessage || "Summarization aborted",
        undefined,
        response.usage,
      ),
    );
  }
  if (response.stopReason === "error") {
    return err(
      new CompactionError(
        "summarization_failed",
        `Summarization failed: ${response.errorMessage || "Unknown error"}`,
        undefined,
        response.usage,
      ),
    );
  }

  const textContent = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  return ok({ summary: textContent, usage: response.usage });
}

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
  currentMessages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
  onProviderDispatch?: () => void,
): Promise<Result<string, CompactionError>> {
  const result = await generateSummaryWithUsage(
    currentMessages,
    model,
    reserveTokens,
    apiKey,
    headers,
    signal,
    customInstructions,
    previousSummary,
    thinkingLevel,
    streamFn,
    runtime,
    undefined,
    onProviderDispatch,
  );
  return result.ok ? ok(result.value.summary) : result;
}

/** Prepared inputs for a compaction run. */
export interface CompactionPreparation {
  /** Entry id where retained history starts. */
  firstKeptEntryId: string;
  /** Messages summarized into the history summary. */
  messagesToSummarize: AgentMessage[];
  /** Prefix messages summarized separately when compaction splits a turn. */
  turnPrefixMessages: AgentMessage[];
  /** Whether compaction splits a turn. */
  isSplitTurn: boolean;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Previous compaction summary used for iterative updates. */
  previousSummary?: string;
  /** File operations extracted from summarized history. */
  fileOps: FileOperations;
  /** Settings used to prepare compaction. */
  settings: CompactionSettings;
}

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
  pathEntries: SessionTreeEntry[],
  settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> {
  if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
    return ok(undefined);
  }

  let prevCompactionIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }

  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
    previousSummary = prevCompaction.summary;
    const firstKeptEntryIndex = pathEntries.findIndex(
      (entry) => entry.id === prevCompaction.firstKeptEntryId,
    );
    boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
  }
  const boundaryEnd = pathEntries.length;

  const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

  const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
  const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return err(
      new CompactionError(
        "invalid_session",
        "First kept entry has no UUID - session may need migration",
      ),
    );
  }
  const firstKeptEntryId = firstKeptEntry.id;

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize: AgentMessage[] = [];
  for (let i = boundaryStart; i < historyEnd; i++) {
    const msg = getMessageFromEntryForCompaction(pathEntries[i]);
    if (msg) {
      messagesToSummarize.push(msg);
    }
  }
  const turnPrefixMessages: AgentMessage[] = [];
  if (cutPoint.isSplitTurn) {
    for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
      const msg = getMessageFromEntryForCompaction(pathEntries[i]);
      if (msg) {
        turnPrefixMessages.push(msg);
      }
    }
  }
  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
  if (cutPoint.isSplitTurn) {
    for (const msg of turnPrefixMessages) {
      extractFileOpsFromMessage(msg, fileOps);
    }
  }

  return ok({
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings,
  });
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export { serializeConversation } from "./utils.js";

/** Generate compaction summary data from prepared session history. */
export async function compact(
  preparation: CompactionPreparation,
  model: Model,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  customInstructions?: string,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
): Promise<Result<CompactionResult, CompactionError>> {
  const {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings,
  } = preparation;

  if (!firstKeptEntryId) {
    return err(
      new CompactionError(
        "invalid_session",
        "First kept entry has no UUID - session may need migration",
      ),
    );
  }

  let summary: string;
  let usage: Usage | undefined;
  const usageBudgetOperationId = `compaction:${uuidv7()}`;

  if (isSplitTurn && turnPrefixMessages.length > 0) {
    const [historyResult, turnPrefixResult] = await Promise.all([
      messagesToSummarize.length > 0
        ? generateSummaryWithUsage(
            messagesToSummarize,
            model,
            settings.reserveTokens,
            apiKey,
            headers,
            signal,
            customInstructions,
            previousSummary,
            thinkingLevel,
            streamFn,
            runtime,
            usageBudgetOperationId,
          )
        : Promise.resolve(ok<GeneratedSummary, CompactionError>({ summary: "No prior history." })),
      generateTurnPrefixSummary(
        turnPrefixMessages,
        model,
        settings.reserveTokens,
        apiKey,
        headers,
        signal,
        thinkingLevel,
        streamFn,
        runtime,
        usageBudgetOperationId,
      ),
    ]);
    if (!historyResult.ok) {
      return err(
        withCompactionErrorUsage(
          historyResult.error,
          turnPrefixResult.ok ? turnPrefixResult.value.usage : turnPrefixResult.error.usage,
          usageBudgetOperationId,
        ),
      );
    }
    if (!turnPrefixResult.ok) {
      return err(
        withCompactionErrorUsage(
          turnPrefixResult.error,
          historyResult.value.usage,
          usageBudgetOperationId,
        ),
      );
    }
    summary = `${historyResult.value.summary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value.summary}`;
    usage = mergeUsage(historyResult.value.usage, turnPrefixResult.value.usage);
  } else {
    const summaryResult = await generateSummaryWithUsage(
      messagesToSummarize,
      model,
      settings.reserveTokens,
      apiKey,
      headers,
      signal,
      customInstructions,
      previousSummary,
      thinkingLevel,
      streamFn,
      runtime,
      usageBudgetOperationId,
    );
    if (!summaryResult.ok) {
      return err(
        withCompactionErrorUsageBudgetOperationId(summaryResult.error, usageBudgetOperationId),
      );
    }
    summary = summaryResult.value.summary;
    usage = summaryResult.value.usage;
  }

  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  return ok({
    summary,
    firstKeptEntryId,
    tokensBefore,
    ...(usage ? { usage } : {}),
    ...(usage ? { usageBudgetOperationId } : {}),
    details: { readFiles, modifiedFiles } as CompactionDetails,
  });
}
async function generateTurnPrefixSummary(
  messages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
  usageBudgetOperationId?: string,
): Promise<Result<GeneratedSummary, CompactionError>> {
  const maxTokens = Math.min(
    Math.floor(0.5 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  const summarizationMessages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: promptText }],
      timestamp: Date.now(),
    },
  ];

  const response = await completeSummarization(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
    createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel),
    streamFn,
    runtime,
    usageBudgetOperationId,
  );
  if (response.stopReason === "aborted") {
    return err(
      new CompactionError(
        "aborted",
        response.errorMessage || "Turn prefix summarization aborted",
        undefined,
        response.usage,
      ),
    );
  }
  if (response.stopReason === "error") {
    return err(
      new CompactionError(
        "summarization_failed",
        `Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`,
        undefined,
        response.usage,
      ),
    );
  }

  return ok({
    summary: response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n"),
    usage: response.usage,
  });
}
