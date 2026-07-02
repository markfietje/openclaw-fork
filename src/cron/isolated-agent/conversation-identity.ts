import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import {
  lookupRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
} from "../../channels/plugins/binding-routing.js";
import type { ChannelCurrentConversationRoute } from "../../channels/plugins/types.core.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveConversationIdentityMode,
  type ConversationIdentityDecision,
} from "../../routing/conversation-identity.js";
import { resolveAgentRoute, type AgentRouteMatch } from "../../routing/resolve-route.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  parseSessionDeliveryRoute,
  parseThreadSessionSuffix,
} from "../../routing/session-key.js";
import type { CronSessionTarget } from "../types.js";
import type { CronPluginConversationRouteResult } from "./conversation-identity.runtime.js";

export type CronConversationIdentityContext = {
  decision: ConversationIdentityDecision;
  routeMatchedBy?: AgentRouteMatch;
  messageProvider?: string;
  chatType?: ChatType;
  agentAccountId?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  senderId?: string;
  senderIsOwner?: boolean;
};

type CronPluginConversationRouteResolver = (params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  target: string;
  conversationId?: string | null;
  chatType: ChatType;
  threadId?: string | number | null;
  senderId?: string | null;
}) => Promise<CronPluginConversationRouteResult>;

type PersistedConversationAudience = {
  channel: string;
  accountId?: string;
  target: string;
  conversationId?: string;
  peerId: string;
  chatType: ChatType;
  threadId?: string | number;
  senderId?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
};

function deniedStaleRoute(): CronConversationIdentityContext {
  return {
    decision: { mode: "external", allowed: false, reason: "stale_route" },
  };
}

function stripPersistedAddressPrefix(raw: string | undefined, channel: string): string | undefined {
  let value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  const providerPrefix = `${channel}:`;
  if (value.toLowerCase().startsWith(providerPrefix.toLowerCase())) {
    value = value.slice(providerPrefix.length);
  }
  return normalizeOptionalString(value.replace(/^(?:user|direct|dm|group|channel):/i, ""));
}

function parseCompactDirectPeer(sessionKey: string): string | undefined {
  const rest = parseAgentSessionKey(sessionKey)?.rest;
  if (!rest?.toLowerCase().startsWith("direct:")) {
    return undefined;
  }
  return normalizeOptionalString(rest.slice("direct:".length));
}

function hasPersistedAudienceMetadata(entry: SessionEntry | undefined): boolean {
  return Boolean(
    entry?.chatType ||
    entry?.channel ||
    entry?.groupId ||
    entry?.groupChannel ||
    entry?.space ||
    entry?.route ||
    entry?.origin ||
    entry?.lastChannel ||
    entry?.lastTo ||
    entry?.lastAccountId ||
    entry?.lastThreadId != null,
  );
}

function resolvePersistedConversationAudience(params: {
  sessionKey: string;
  sessionEntry?: SessionEntry;
}): PersistedConversationAudience | null | undefined {
  const entry = params.sessionEntry;
  const delivery = parseSessionDeliveryRoute(params.sessionKey);
  const compactDirectPeer = parseCompactDirectPeer(params.sessionKey);
  if (!delivery && !compactDirectPeer && !hasPersistedAudienceMetadata(entry)) {
    return undefined;
  }

  const channel =
    normalizeOptionalLowercaseString(delivery?.channel) ??
    normalizeOptionalLowercaseString(entry?.route?.channel) ??
    normalizeOptionalLowercaseString(entry?.origin?.provider) ??
    normalizeOptionalLowercaseString(entry?.origin?.surface) ??
    normalizeOptionalLowercaseString(entry?.channel) ??
    normalizeOptionalLowercaseString(entry?.lastChannel);
  const chatType = normalizeChatType(
    entry?.chatType ??
      entry?.origin?.chatType ??
      entry?.route?.target?.chatType ??
      delivery?.peerKind ??
      (compactDirectPeer ? "direct" : undefined),
  );
  if (!channel || !chatType) {
    return null;
  }

  const routeDirectPeer =
    normalizeOptionalString(entry?.origin?.nativeDirectUserId) ??
    (delivery && normalizeChatType(delivery.peerKind) === "direct"
      ? normalizeOptionalString(delivery.peerId)
      : undefined) ??
    compactDirectPeer;
  const target =
    normalizeOptionalString(entry?.route?.target?.to) ??
    (chatType === "direct"
      ? routeDirectPeer
      : normalizeOptionalString(entry?.origin?.nativeChannelId)) ??
    normalizeOptionalString(delivery?.peerId) ??
    normalizeOptionalString(entry?.origin?.to) ??
    normalizeOptionalString(entry?.lastTo) ??
    normalizeOptionalString(entry?.groupId) ??
    (chatType === "direct" ? stripPersistedAddressPrefix(entry?.origin?.from, channel) : undefined);
  if (!target) {
    return null;
  }

  const peerId = stripPersistedAddressPrefix(target, channel);
  if (!peerId) {
    return null;
  }
  const senderId =
    normalizeOptionalString(entry?.origin?.nativeDirectUserId) ??
    stripPersistedAddressPrefix(entry?.origin?.from, channel) ??
    undefined;
  const groupId =
    chatType === "direct"
      ? undefined
      : (normalizeOptionalString(entry?.groupId) ??
        normalizeOptionalString(entry?.origin?.nativeChannelId) ??
        peerId);
  return {
    channel,
    accountId:
      normalizeOptionalString(delivery?.accountId) ??
      normalizeOptionalString(entry?.route?.accountId) ??
      normalizeOptionalString(entry?.origin?.accountId) ??
      normalizeOptionalString(entry?.lastAccountId),
    target,
    conversationId: normalizeOptionalString(entry?.origin?.nativeChannelId),
    peerId,
    chatType,
    threadId:
      entry?.route?.thread?.id ??
      entry?.origin?.threadId ??
      entry?.lastThreadId ??
      delivery?.threadId,
    senderId,
    groupId,
    groupChannel: normalizeOptionalString(entry?.groupChannel),
    groupSpace: normalizeOptionalString(entry?.space),
  };
}

function resolveGenericCurrentRoute(params: {
  cfg: OpenClawConfig;
  audience: PersistedConversationAudience;
}): ChannelCurrentConversationRoute | null {
  const { audience } = params;
  let route = resolveAgentRoute({
    cfg: params.cfg,
    channel: audience.channel,
    accountId: audience.accountId,
    peer: { kind: audience.chatType, id: audience.peerId },
    guildId: audience.groupSpace,
    teamId: audience.groupSpace,
  });
  const conversation = {
    channel: audience.channel,
    accountId: route.accountId,
    conversationId: audience.peerId,
  };
  route = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    route,
    conversation,
  }).route;
  const runtimeRoute = lookupRuntimeConversationBindingRoute({ route, conversation });
  if (runtimeRoute.bindingRecord && !runtimeRoute.boundSessionKey) {
    return null;
  }
  return runtimeRoute.route;
}

async function resolveCurrentRoute(params: {
  cfg: OpenClawConfig;
  audience: PersistedConversationAudience;
  resolvePluginRoute?: CronPluginConversationRouteResolver;
}): Promise<ChannelCurrentConversationRoute | null> {
  const resolvePluginRoute =
    params.resolvePluginRoute ??
    (async (input) => {
      const runtime = await import("./conversation-identity.runtime.js");
      return await runtime.resolveCronPluginConversationRoute(input);
    });
  const pluginResult = await resolvePluginRoute({
    cfg: params.cfg,
    channel: params.audience.channel,
    accountId: params.audience.accountId,
    target: params.audience.target,
    conversationId: params.audience.conversationId,
    chatType: params.audience.chatType,
    threadId: params.audience.threadId,
    senderId: params.audience.senderId,
  });
  if (pluginResult.kind === "resolved") {
    return pluginResult.route;
  }
  if (pluginResult.kind === "unresolved") {
    return null;
  }
  return resolveGenericCurrentRoute(params);
}

/** Revalidates persistent channel sessions against the current registry and binding config. */
export async function resolveCronConversationIdentityContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionTarget: CronSessionTarget;
  sessionEntry?: SessionEntry;
  resolvePluginRoute?: CronPluginConversationRouteResolver;
}): Promise<CronConversationIdentityContext> {
  const currentAgent = resolveConversationIdentityMode({
    config: params.cfg,
    agentId: params.agentId,
    isInternal: true,
  });
  if (!currentAgent.allowed) {
    return { decision: currentAgent };
  }
  if (params.sessionTarget === "isolated") {
    return { decision: currentAgent };
  }

  const parsedAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  if (!parsedAgentId || normalizeAgentId(parsedAgentId) !== normalizeAgentId(params.agentId)) {
    return deniedStaleRoute();
  }
  const audience = resolvePersistedConversationAudience(params);
  if (audience === undefined) {
    // Named internal sessions have no external audience to inherit. They still
    // require a currently configured agent on every scheduled turn.
    return { decision: currentAgent };
  }
  if (!audience) {
    return deniedStaleRoute();
  }

  const currentRoute = await resolveCurrentRoute({
    cfg: params.cfg,
    audience,
    resolvePluginRoute: params.resolvePluginRoute,
  });
  const targetBaseSessionKey =
    parseThreadSessionSuffix(params.sessionKey).baseSessionKey ?? params.sessionKey;
  const currentBaseSessionKey = currentRoute
    ? (parseThreadSessionSuffix(currentRoute.sessionKey).baseSessionKey ?? currentRoute.sessionKey)
    : undefined;
  if (
    !currentRoute ||
    normalizeAgentId(currentRoute.agentId) !== normalizeAgentId(params.agentId) ||
    currentBaseSessionKey !== targetBaseSessionKey
  ) {
    return deniedStaleRoute();
  }

  const senderIsOwnerFromConfig = audience.senderId
    ? resolveCommandAuthorization({
        cfg: params.cfg,
        commandAuthorized: false,
        ctx: {
          Provider: audience.channel,
          Surface: audience.channel,
          AccountId: currentRoute.accountId,
          ChatType: audience.chatType,
          SenderId: audience.senderId,
          From: params.sessionEntry?.origin?.from,
          To: params.sessionEntry?.origin?.to,
        },
      }).stableSenderIsOwner
    : false;
  const senderIsOwner = currentRoute.senderIsOwner === true || senderIsOwnerFromConfig;
  const decision = resolveConversationIdentityMode({
    config: params.cfg,
    agentId: currentRoute.agentId,
    routeMatchedBy: currentRoute.matchedBy,
    chatType: audience.chatType,
    groupId: audience.groupId,
    groupChannel: audience.groupChannel,
    groupSpace: audience.groupSpace,
    senderIsOwner,
  });
  return {
    decision,
    routeMatchedBy: currentRoute.matchedBy,
    messageProvider: currentRoute.channel,
    chatType: audience.chatType,
    agentAccountId: currentRoute.accountId,
    groupId: audience.groupId,
    groupChannel: audience.groupChannel,
    groupSpace: audience.groupSpace,
    senderId: audience.senderId,
    senderIsOwner,
  };
}
