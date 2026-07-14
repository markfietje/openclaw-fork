/** Canonical modifying and observation hooks for one logical reply delivery attempt. */
import {
  deriveInboundMessageHookContext,
  toPluginMessageContext,
} from "../hooks/message-hook-mappers.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runMessageSendingHookForPayload } from "../infra/outbound/message-sending-hook.js";
import {
  createMessageSentHookEmitter,
  getSuccessfulNativeDelivery,
  isMessageSentHookOwned,
} from "../infra/outbound/message-sent-hook.js";
import {
  createOutboundPayloadPlan,
  summarizeOutboundPayloadForTransport,
} from "../infra/outbound/payloads.js";
import { hasOutboundReplyContent } from "../plugin-sdk/reply-payload.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "./reply-payload.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  composeReplyDispatchBeforeDeliver,
  markReplyDispatchBeforeDeliverDeadlineOwned,
  type ReplyDispatchBeforeDeliver,
} from "./reply/reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";
import { runReplyPayloadSendingHook } from "./reply/reply-payload-sending-hook.js";
import { consumeReplyUsageState } from "./reply/reply-usage-state.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

export type ReplyPayloadRunState = {
  runId?: string;
};

const outboundBeforeDeliverDispatchers = new WeakSet<ReplyDispatcher>();
const outboundAfterDeliverDispatchers = new WeakSet<ReplyDispatcher>();

function resolveInboundReplyHookTarget(
  finalized: FinalizedMsgContext,
  hookCtx: ReturnType<typeof deriveInboundMessageHookContext>,
): string {
  if (typeof finalized.OriginatingTo === "string" && finalized.OriginatingTo.trim()) {
    return finalized.OriginatingTo;
  }
  if (hookCtx.isGroup) {
    return hookCtx.conversationId ?? hookCtx.to ?? hookCtx.from;
  }
  return hookCtx.from || hookCtx.conversationId || hookCtx.to || "";
}

function buildMessageSendingBeforeDeliver(
  ctx: MsgContext | FinalizedMsgContext,
): ReplyDispatchBeforeDeliver {
  const finalized = finalizeInboundContext(ctx);
  const hookCtx = deriveInboundMessageHookContext(finalized);
  const replyTarget = resolveInboundReplyHookTarget(finalized, hookCtx);

  return markReplyDispatchBeforeDeliverDeadlineOwned(
    async (payload: ReplyPayload): Promise<ReplyPayload | null> => {
      const hookRunner = getGlobalHookRunner();
      const plannedPayload = createOutboundPayloadPlan([payload])[0]?.payload ?? payload;
      const result = await runMessageSendingHookForPayload({
        hookRunner,
        enabled: hookRunner?.hasHooks("message_sending") ?? false,
        payload,
        payloadSummary: summarizeOutboundPayloadForTransport(plannedPayload),
        to: replyTarget,
        channel: finalized.Surface ?? finalized.Provider ?? hookCtx.channelId,
        accountId: finalized.AccountId ?? hookCtx.accountId,
        replyToId: payload.replyToId,
        threadId: finalized.TransportThreadId ?? finalized.MessageThreadId,
        sessionKey: finalized.SessionKey,
      });
      if (result.cancelled) {
        return null;
      }
      const hookedPayload =
        result.payload === payload ? payload : copyReplyPayloadMetadata(payload, result.payload);
      return hasOutboundReplyContent(hookedPayload) ? hookedPayload : null;
    },
  );
}

function countReplyPayloadMedia(payload: ReplyPayload): number {
  return createOutboundPayloadPlan([payload])[0]?.parts.mediaCount ?? 0;
}

function buildOutboundHookLifecycleStart(
  runState: ReplyPayloadRunState,
): ReplyDispatchBeforeDeliver {
  return markReplyDispatchBeforeDeliverDeadlineOwned((payload) => {
    setReplyPayloadMetadata(payload, {
      outboundHookLifecycle: {
        state: "pending",
        originalMediaCount: countReplyPayloadMedia(payload),
        ...(runState.runId ? { runId: runState.runId } : {}),
      },
    });
    return payload;
  });
}

function buildOutboundHookLifecycleComplete(): ReplyDispatchBeforeDeliver {
  return markReplyDispatchBeforeDeliverDeadlineOwned((payload) => {
    const lifecycle = getReplyPayloadMetadata(payload)?.outboundHookLifecycle;
    setReplyPayloadMetadata(payload, {
      outboundHookLifecycle: {
        state: "prepared",
        originalMediaCount: lifecycle?.originalMediaCount ?? countReplyPayloadMedia(payload),
        ...(lifecycle?.runId ? { runId: lifecycle.runId } : {}),
      },
    });
    return payload;
  });
}

function buildReplyPayloadSendingBeforeDeliver(
  ctx: MsgContext | FinalizedMsgContext,
  runState: ReplyPayloadRunState,
): ReplyDispatchBeforeDeliver {
  const finalized = finalizeInboundContext(ctx);
  const hookCtx = deriveInboundMessageHookContext(finalized);

  return markReplyDispatchBeforeDeliverDeadlineOwned(
    async (payload: ReplyPayload, info): Promise<ReplyPayload | null> => {
      const runId = runState.runId;
      const hookedPayload = await runReplyPayloadSendingHook({
        payload,
        kind: info.kind,
        channel: finalized.Surface ?? finalized.Provider,
        sessionKey: finalized.SessionKey,
        runId,
        usageState: consumeReplyUsageState(runId),
        context: {
          ...toPluginMessageContext(hookCtx),
          runId,
        },
      });
      return hookedPayload && hasOutboundReplyContent(hookedPayload) ? hookedPayload : null;
    },
  );
}

export function hasOutboundModifyingHooks(): boolean {
  const hookRunner = getGlobalHookRunner();
  return Boolean(
    hookRunner?.hasHooks("reply_payload_sending") || hookRunner?.hasHooks("message_sending"),
  );
}

export function buildOutboundHookBeforeDeliver(
  ctx: MsgContext | FinalizedMsgContext,
  runState: ReplyPayloadRunState,
): ReplyDispatchBeforeDeliver | undefined {
  return composeReplyDispatchBeforeDeliver(
    buildOutboundHookLifecycleStart(runState),
    buildReplyPayloadSendingBeforeDeliver(ctx, runState),
    buildMessageSendingBeforeDeliver(ctx),
    buildOutboundHookLifecycleComplete(),
  );
}

export function installOutboundHookBeforeDeliver(
  dispatcher: ReplyDispatcher,
  ctx: MsgContext | FinalizedMsgContext,
  runState: ReplyPayloadRunState,
): void {
  if (outboundBeforeDeliverDispatchers.has(dispatcher)) {
    return;
  }
  const beforeDeliver = buildOutboundHookBeforeDeliver(ctx, runState);
  // Shipped low-level SDK dispatchers may only expose append. Preserve that
  // contract; canonical core dispatchers prepend before provider preparation.
  const installBeforeDeliver = dispatcher.prependBeforeDeliver ?? dispatcher.appendBeforeDeliver;
  if (!beforeDeliver || !installBeforeDeliver) {
    return;
  }
  installBeforeDeliver.call(dispatcher, beforeDeliver);
  outboundBeforeDeliverDispatchers.add(dispatcher);
}

export function markOutboundHookBeforeDeliverInstalled(
  dispatcher: ReplyDispatcher,
  beforeDeliver: ReplyDispatchBeforeDeliver | undefined,
): void {
  if (beforeDeliver) {
    outboundBeforeDeliverDispatchers.add(dispatcher);
  }
}

function resolveDeliveryMessageId(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const direct = (result as { messageId?: unknown }).messageId;
  if (typeof direct === "string" && direct) {
    return direct;
  }
  const platformIds = (result as { receipt?: { platformMessageIds?: unknown } }).receipt
    ?.platformMessageIds;
  return Array.isArray(platformIds)
    ? platformIds.find((value): value is string => typeof value === "string" && value.length > 0)
    : undefined;
}

function resolveDeliveryContent(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const content = (result as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

function isExplicitlyNonVisibleDelivery(deliveryResult: unknown): boolean {
  return (
    typeof deliveryResult === "object" &&
    deliveryResult !== null &&
    !Array.isArray(deliveryResult) &&
    "visibleReplySent" in deliveryResult &&
    (deliveryResult as { visibleReplySent?: unknown }).visibleReplySent === false
  );
}

export function installOutboundHookAfterDeliver(
  dispatcher: ReplyDispatcher,
  ctx: MsgContext | FinalizedMsgContext,
  runState: ReplyPayloadRunState,
): void {
  if (outboundAfterDeliverDispatchers.has(dispatcher) || !dispatcher.appendAfterDeliver) {
    return;
  }
  const finalized = finalizeInboundContext(ctx);
  const hookCtx = deriveInboundMessageHookContext(finalized);
  const emitMessageSent = createMessageSentHookEmitter({
    channel: finalized.Surface ?? finalized.Provider ?? hookCtx.channelId,
    to: resolveInboundReplyHookTarget(finalized, hookCtx),
    accountId: finalized.AccountId ?? hookCtx.accountId,
    sessionKey: finalized.SessionKey,
    isGroup: hookCtx.isGroup,
    groupId: hookCtx.groupId,
  });
  dispatcher.appendAfterDeliver((payload, _info, outcome) => {
    const runId = getReplyPayloadMetadata(payload)?.outboundHookLifecycle?.runId ?? runState.runId;
    const owner = outcome.status === "delivered" ? outcome.result : outcome.error;
    const successfulNativeDelivery = getSuccessfulNativeDelivery(owner);
    if (
      isMessageSentHookOwned(owner) ||
      (outcome.status === "delivered" && isExplicitlyNonVisibleDelivery(outcome.result))
    ) {
      return;
    }
    const success = outcome.status === "delivered" || successfulNativeDelivery !== undefined;
    emitMessageSent({
      success,
      content:
        (outcome.status === "delivered" ? resolveDeliveryContent(outcome.result) : undefined) ??
        (payload.text || payload.spokenText || ""),
      ...(success
        ? {
            messageId:
              successfulNativeDelivery?.messageId ??
              (outcome.status === "delivered"
                ? resolveDeliveryMessageId(outcome.result)
                : undefined),
          }
        : { error: formatErrorMessage(outcome.error) }),
      ...(runId ? { runId } : {}),
    });
  });
  outboundAfterDeliverDispatchers.add(dispatcher);
}
