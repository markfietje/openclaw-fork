import type { StatusFooterMode } from "../config/types.messages.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("channels/status-footer");
const MAX_ACTIVITY_CHARS = 60;
export const STATUS_FOOTER_MAX_RENDERED_CHARS = 384;
const MAX_TERMINAL_RUNS = 4_096;

type StatusFooterRecord = {
  messageId: string;
  textWithoutFooter: string;
  footerText: string;
  runId?: string;
  edit: (messageId: string, text: string) => Promise<void>;
};

type StatusFooterActivity = {
  line: string;
  runId?: string;
};

const records = new Map<string, StatusFooterRecord>();
const activities = new Map<string, StatusFooterActivity>();
const runStartedAt = new Map<string, number>();
const chains = new Map<string, Promise<void>>();
const pendingConversationCountsByRun = new Map<string, Map<string, number>>();
const terminalRuns = new Set<string>();

export function createStatusFooterConversationKey(
  channel: string,
  to: string,
  options?: { accountId?: string; threadId?: string | number | null },
): string {
  return JSON.stringify([channel, options?.accountId ?? null, to, options?.threadId ?? null]);
}

export function resolveStatusFooterMode(
  config: OpenClawConfig,
  channelId: string,
): StatusFooterMode {
  const configured = config.messages?.statusFooter;
  if (typeof configured === "string") {
    return configured;
  }
  return configured?.[channelId] ?? configured?.default ?? "activity";
}

export function noteStatusFooterRunStarted(runId: string, startedAt: number): void {
  if (Number.isFinite(startedAt)) {
    runStartedAt.set(runId, startedAt);
  }
}

function normalizeActivity(line: string): string {
  const normalized = line.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_ACTIVITY_CHARS) {
    return normalized;
  }
  const contentLimit = MAX_ACTIVITY_CHARS - 1;
  const candidate = normalized.slice(0, contentLimit + 1);
  const wordBoundary = candidate.lastIndexOf(" ");
  const end = wordBoundary >= Math.floor(contentLimit * 0.6) ? wordBoundary : contentLimit;
  return `${normalized.slice(0, end).trimEnd()}…`;
}

export function noteActivity(conversationKey: string, line: string, runId?: string): void {
  if (runId && terminalRuns.has(runId)) {
    return;
  }
  const normalized = normalizeActivity(line);
  if (!normalized) {
    return;
  }
  activities.set(conversationKey, { line: normalized, ...(runId ? { runId } : {}) });
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderFooter(params: {
  conversationKey: string;
  mode: Exclude<StatusFooterMode, "off">;
  runId?: string;
  now: number;
  escapeHtml: boolean;
}): string {
  const activity = activities.get(params.conversationKey);
  const activityMatchesRun = !activity?.runId || !params.runId || activity.runId === params.runId;
  const label =
    params.mode === "activity" && activityMatchesRun && activity?.line ? activity.line : "Working";
  const startedAt = params.runId ? runStartedAt.get(params.runId) : undefined;
  const elapsed =
    formatDurationCompact(Math.max(0, params.now - (startedAt ?? params.now))) ?? "0s";
  const footer = `▸ ${label} · ${elapsed} · reply to steer`;
  return params.escapeHtml ? escapeHtml(footer) : footer;
}

function enqueue<T>(conversationKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = chains.get(conversationKey) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const settled = result.then(
    () => {},
    () => {},
  );
  chains.set(conversationKey, settled);
  void settled.finally(() => {
    if (chains.get(conversationKey) === settled) {
      chains.delete(conversationKey);
    }
  });
  return result;
}

async function stripRecord(conversationKey: string, runId?: string): Promise<void> {
  const record = records.get(conversationKey);
  if (!record || (runId && record.runId && record.runId !== runId)) {
    return;
  }
  // Delete first: an edit failure may leave one stale line, but never poisons later relocation.
  records.delete(conversationKey);
  try {
    await record.edit(record.messageId, record.textWithoutFooter);
  } catch (error) {
    log.debug("status footer strip failed", {
      conversationKey,
      messageId: record.messageId,
      error: String(error),
    });
  }
}

export async function decorateIntermediate<T>(params: {
  conversationKey: string;
  mode: StatusFooterMode;
  runId?: string;
  textWithoutFooter: string;
  send: (text: string) => Promise<T>;
  getMessageId: (result: T) => string | undefined;
  edit: (messageId: string, text: string) => Promise<void>;
  now?: () => number;
  escapeHtml?: boolean;
}): Promise<T> {
  const mode = params.mode;
  if (mode === "off" || (params.runId && terminalRuns.has(params.runId))) {
    return await params.send(params.textWithoutFooter);
  }
  const pendingConversationCounts = params.runId
    ? (pendingConversationCountsByRun.get(params.runId) ?? new Map<string, number>())
    : undefined;
  if (params.runId && pendingConversationCounts) {
    pendingConversationCounts.set(
      params.conversationKey,
      (pendingConversationCounts.get(params.conversationKey) ?? 0) + 1,
    );
    pendingConversationCountsByRun.set(params.runId, pendingConversationCounts);
  }
  try {
    return await enqueue(params.conversationKey, async () => {
      await stripRecord(params.conversationKey);
      const footerText = renderFooter({
        conversationKey: params.conversationKey,
        mode,
        runId: params.runId,
        now: (params.now ?? Date.now)(),
        escapeHtml: params.escapeHtml === true,
      });
      const result = await params.send(`${params.textWithoutFooter}\n\n${footerText}`);
      const messageId = params.getMessageId(result);
      if (messageId) {
        // Exact rendered text is the edit source of truth; regex stripping would risk user content.
        records.set(params.conversationKey, {
          messageId,
          textWithoutFooter: params.textWithoutFooter,
          footerText,
          ...(params.runId ? { runId: params.runId } : {}),
          edit: params.edit,
        });
      }
      return result;
    });
  } finally {
    if (params.runId && pendingConversationCounts) {
      const remaining = (pendingConversationCounts.get(params.conversationKey) ?? 1) - 1;
      if (remaining > 0) {
        pendingConversationCounts.set(params.conversationKey, remaining);
      } else {
        pendingConversationCounts.delete(params.conversationKey);
      }
      if (pendingConversationCounts.size === 0) {
        pendingConversationCountsByRun.delete(params.runId);
      }
    }
  }
}

export async function stripPrevious(conversationKey: string, runId?: string): Promise<void> {
  await enqueue(conversationKey, async () => {
    await stripRecord(conversationKey, runId);
  });
}

export async function finalize(conversationKey: string, runId?: string): Promise<void> {
  await enqueue(conversationKey, async () => {
    await stripRecord(conversationKey, runId);
    const activity = activities.get(conversationKey);
    if (!runId || !activity?.runId || activity.runId === runId) {
      activities.delete(conversationKey);
    }
  });
}

export async function finalizeStatusFooterRun(runId: string): Promise<void> {
  // Late delivery work must not recreate a footer after cancel/error cleanup snapshots the run.
  terminalRuns.add(runId);
  if (terminalRuns.size > MAX_TERMINAL_RUNS) {
    const oldestRunId = terminalRuns.values().next().value;
    if (oldestRunId) {
      terminalRuns.delete(oldestRunId);
    }
  }
  const conversationKeys = new Set<string>();
  for (const key of pendingConversationCountsByRun.get(runId)?.keys() ?? []) {
    conversationKeys.add(key);
  }
  for (const [key, record] of records) {
    if (record.runId === runId) {
      conversationKeys.add(key);
    }
  }
  for (const [key, activity] of activities) {
    if (activity.runId === runId) {
      conversationKeys.add(key);
    }
  }
  await Promise.all(
    Array.from(conversationKeys)
      .toSorted()
      .map((key) => finalize(key, runId)),
  );
  runStartedAt.delete(runId);
  pendingConversationCountsByRun.delete(runId);
}

export function resetStatusFooterStateForTest(): void {
  records.clear();
  activities.clear();
  runStartedAt.clear();
  chains.clear();
  pendingConversationCountsByRun.clear();
  terminalRuns.clear();
}
