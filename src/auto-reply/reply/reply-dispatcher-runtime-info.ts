import { getReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import type { ReplyDispatchKind, ReplyDispatchRuntimeInfo } from "./reply-dispatcher.types.js";

export function buildReplyDispatchRuntimeInfo(
  payload: ReplyPayload,
  kind: ReplyDispatchKind,
): ReplyDispatchRuntimeInfo {
  const assistantMessageIndex = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
  return {
    kind,
    ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}),
  };
}
