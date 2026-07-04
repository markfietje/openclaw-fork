// Source-bound message policy validators shared by tool admission and final delivery.
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";

const MASS_MENTION_RE = /<!(?:channel|here|everyone|subteam\^)[^>]*>/iu;
const NATIVE_USER_MENTION_RE = /<@[A-Z0-9]+(?:\|[^>]*)?>/iu;
const INLINE_DELIVERY_DIRECTIVE_RE = /\[\[[^\]\r\n]*\]\]/u;
const MEDIA_DELIVERY_DIRECTIVE_RE = /\bMEDIA\s*:/iu;

export const SOURCE_BOUND_MESSAGE_MAX_UTF8_BYTES = 2_000;

function denySourceBoundMessage(reason: string): never {
  throw new Error(`Source-bound message policy denied this action: ${reason}`);
}

/** Confirms a passive-turn message policy contains a complete immutable source route. */
export function isValidSourceBoundMessagePolicy(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const policy = value as Record<string, unknown>;
  if (policy.mode !== "source_bound") {
    return false;
  }
  for (const field of ["channel", "accountId", "conversationId"] as const) {
    if (typeof policy[field] !== "string" || !policy[field].trim()) {
      return false;
    }
  }
  return (
    policy.threadId === undefined ||
    (typeof policy.threadId === "string" && !!policy.threadId.trim())
  );
}

export function assertSourceBoundMessageText(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    denySourceBoundMessage("message must be non-empty plain text");
  }
  if (INLINE_DELIVERY_DIRECTIVE_RE.test(value) || MEDIA_DELIVERY_DIRECTIVE_RE.test(value)) {
    denySourceBoundMessage("message delivery directives are not allowed");
  }
  if (MASS_MENTION_RE.test(value)) {
    denySourceBoundMessage("channel-wide and user-group mentions are not allowed");
  }
  if (NATIVE_USER_MENTION_RE.test(value)) {
    denySourceBoundMessage("native user and app mentions are not allowed");
  }
  if (Buffer.byteLength(value, "utf8") > SOURCE_BOUND_MESSAGE_MAX_UTF8_BYTES) {
    denySourceBoundMessage(`message exceeds ${SOURCE_BOUND_MESSAGE_MAX_UTF8_BYTES} UTF-8 bytes`);
  }
}

export function assertSourceBoundReplyPayload(payload: ReplyPayload): void {
  assertSourceBoundMessageText(payload.text);
  const nonTextFields: Array<[keyof ReplyPayload, unknown]> = [
    ["mediaUrl", payload.mediaUrl],
    ["mediaUrls", payload.mediaUrls],
    ["trustedLocalMedia", payload.trustedLocalMedia],
    ["sensitiveMedia", payload.sensitiveMedia],
    ["presentation", payload.presentation],
    ["delivery", payload.delivery],
    ["interactive", payload.interactive],
    ["btw", payload.btw],
    ["replyToId", payload.replyToId],
    ["replyToTag", payload.replyToTag],
    ["replyToCurrent", payload.replyToCurrent],
    ["audioAsVoice", payload.audioAsVoice],
    ["spokenText", payload.spokenText],
    ["ttsSupplement", payload.ttsSupplement],
    ["channelData", payload.channelData],
  ];
  const nonTextField = nonTextFields.find(([, value]) => {
    if (value === undefined || value === null || value === false) {
      return false;
    }
    if (typeof value === "string" || Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  });
  if (nonTextField) {
    denySourceBoundMessage(`final payload field ${nonTextField[0]} is not allowed`);
  }
}
