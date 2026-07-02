// Matrix plugin module implements session route behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  type ChannelCurrentConversationRouteParams,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { parseThreadSessionSuffix, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveMatrixAccountConfig } from "./matrix/account-config.js";
import { resolveDefaultMatrixAccountId } from "./matrix/accounts.js";
import { resolveMatrixInboundRoute } from "./matrix/monitor/route.js";
import { resolveMatrixStoredSessionMeta } from "./matrix/session-store-metadata.js";
import { resolveMatrixTargetIdentity } from "./matrix/target-ids.js";

function resolveEffectiveMatrixAccountId(
  params: Pick<ChannelOutboundSessionRouteParams, "cfg" | "accountId">,
): string {
  return normalizeAccountId(params.accountId ?? resolveDefaultMatrixAccountId(params.cfg));
}

function resolveMatrixDmSessionScope(params: {
  cfg: ChannelOutboundSessionRouteParams["cfg"];
  accountId: string;
}): "per-user" | "per-room" {
  return (
    resolveMatrixAccountConfig({
      cfg: params.cfg,
      accountId: params.accountId,
    }).dm?.sessionScope ?? "per-user"
  );
}

function resolveMatrixCurrentDmRoomId(params: {
  cfg: ChannelOutboundSessionRouteParams["cfg"];
  agentId: string;
  accountId: string;
  currentSessionKey?: string;
  targetUserId: string;
}): string | undefined {
  const sessionKey =
    parseThreadSessionSuffix(params.currentSessionKey).baseSessionKey ??
    params.currentSessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.agentId,
    });
    const existing = getSessionEntry({
      storePath,
      sessionKey,
    });
    const currentSession = resolveMatrixStoredSessionMeta(existing);
    if (!currentSession) {
      return undefined;
    }
    if (currentSession.accountId && currentSession.accountId !== params.accountId) {
      return undefined;
    }
    if (!currentSession.directUserId || currentSession.directUserId !== params.targetUserId) {
      return undefined;
    }
    return currentSession.roomId;
  } catch {
    return undefined;
  }
}

export function resolveMatrixOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const target =
    resolveMatrixTargetIdentity(params.resolvedTarget?.to ?? params.target) ??
    resolveMatrixTargetIdentity(params.target);
  if (!target) {
    return null;
  }
  const effectiveAccountId = resolveEffectiveMatrixAccountId(params);
  const roomScopedDmId =
    target.kind === "user" &&
    resolveMatrixDmSessionScope({
      cfg: params.cfg,
      accountId: effectiveAccountId,
    }) === "per-room"
      ? resolveMatrixCurrentDmRoomId({
          cfg: params.cfg,
          agentId: params.agentId,
          accountId: effectiveAccountId,
          currentSessionKey: params.currentSessionKey,
          targetUserId: target.id,
        })
      : undefined;
  const peer =
    roomScopedDmId !== undefined
      ? { kind: "channel" as const, id: roomScopedDmId }
      : {
          kind: target.kind === "user" ? ("direct" as const) : ("channel" as const),
          id: target.id,
        };
  const chatType = target.kind === "user" ? "direct" : "channel";
  const from = target.kind === "user" ? `matrix:${target.id}` : `matrix:channel:${target.id}`;
  const to = `room:${roomScopedDmId ?? target.id}`;

  const baseRoute = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "matrix",
    accountId: effectiveAccountId,
    peer,
    chatType,
    from,
    to,
  });
  return buildThreadAwareOutboundSessionRoute({
    route: baseRoute,
    replyToId: params.replyToId,
    threadId: params.threadId,
    currentSessionKey: params.currentSessionKey,
    normalizeThreadId: (threadId) => threadId,
    canRecoverCurrentThread: ({ route }) =>
      route.peer.kind !== "direct" || (params.cfg.session?.dmScope ?? "main") !== "main",
  });
}

export function resolveMatrixCurrentConversationRoute(
  params: ChannelCurrentConversationRouteParams,
) {
  const target = resolveMatrixTargetIdentity(params.conversationId ?? params.target);
  if (!target || target.kind !== "room") {
    return null;
  }
  const isDirectMessage = params.chatType === "direct";
  const sender = isDirectMessage ? resolveMatrixTargetIdentity(params.senderId ?? "") : undefined;
  if (isDirectMessage && sender?.kind !== "user") {
    return null;
  }
  const accountId = resolveEffectiveMatrixAccountId(params);
  const { route } = resolveMatrixInboundRoute({
    cfg: params.cfg,
    accountId,
    roomId: target.id,
    senderId: sender?.id ?? params.senderId ?? "",
    isDirectMessage,
    dmSessionScope: resolveMatrixDmSessionScope({ cfg: params.cfg, accountId }),
    threadId: params.threadId == null ? undefined : String(params.threadId),
    resolveAgentRoute,
  });
  return route;
}
