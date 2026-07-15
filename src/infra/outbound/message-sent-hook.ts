import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "../../hooks/message-hook-mappers.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";

const log = createSubsystemLogger("outbound/message-sent-hook");
const messageSentHookOwnedResults = new WeakSet<object>();
const successfulNativeDeliveries = new WeakMap<object, { messageId?: string }>();

type MessageSentHookEvent = {
  success: boolean;
  content: string;
  error?: string;
  messageId?: string;
  runId?: string;
};

export function markMessageSentHookOwned<T>(value: T): T {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    messageSentHookOwnedResults.add(value as object);
  }
  return value;
}

export function isMessageSentHookOwned(value: unknown): boolean {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    messageSentHookOwnedResults.has(value as object)
  );
}

/** Carries a completed native send through a later bookkeeping failure to the outer observer. */
export function markSuccessfulNativeDelivery<T>(value: T, messageId?: string): T {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    successfulNativeDeliveries.set(value as object, messageId ? { messageId } : {});
  }
  return value;
}

/** Reads native-send success that occurred before a later non-transport failure. */
export function getSuccessfulNativeDelivery(value: unknown): { messageId?: string } | undefined {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? successfulNativeDeliveries.get(value as object)
    : undefined;
}

export function createMessageSentHookEmitter(params: {
  channel: string;
  to: string;
  accountId?: string;
  sessionKey?: string;
  isGroup?: boolean;
  groupId?: string;
}): (event: MessageSentHookEvent) => void {
  const canEmitInternalHook = Boolean(params.sessionKey);

  return (event) => {
    const hookRunner = getGlobalHookRunner();
    const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
    if (!hasMessageSentHooks && !canEmitInternalHook) {
      return;
    }
    const canonical = buildCanonicalSentMessageHookContext({
      to: params.to,
      content: event.content,
      success: event.success,
      error: event.error,
      channelId: params.channel,
      accountId: params.accountId,
      conversationId: params.to,
      sessionKey: params.sessionKey,
      runId: event.runId,
      messageId: event.messageId,
      isGroup: params.isGroup,
      groupId: params.groupId,
    });
    if (hasMessageSentHooks) {
      fireAndForgetHook(
        hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
        "message_sent plugin hook failed",
        (message) => {
          log.warn(message);
        },
      );
    }
    if (!canEmitInternalHook) {
      return;
    }
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "sent",
          params.sessionKey!,
          toInternalMessageSentContext(canonical),
        ),
      ),
      "message:sent internal hook failed",
      (message) => {
        log.warn(message);
      },
    );
  };
}
