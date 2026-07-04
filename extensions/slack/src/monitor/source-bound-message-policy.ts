// Slack helper builds immutable source-bound message-tool routes.
import type { SourceBoundMessagePolicy } from "openclaw/plugin-sdk/reply-runtime";

export function buildSlackSourceBoundMessagePolicy(params: {
  accountId: string;
  conversationId: string;
  threadId?: string | number;
}): SourceBoundMessagePolicy {
  const rawThreadId = params.threadId;
  const threadId = rawThreadId === undefined ? undefined : String(rawThreadId);
  return Object.freeze({
    mode: "source_bound" as const,
    channel: "slack",
    accountId: params.accountId,
    conversationId: params.conversationId,
    ...(threadId?.trim() ? { threadId } : {}),
  });
}
