// Whatsapp plugin module implements session route behavior.
import { readStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/channel-policy";
import { resolveConfiguredBindingRoute } from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  buildChannelOutboundSessionRoute,
  type ChannelCurrentConversationRouteParams,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { resolveAgentRoute, resolveStableSenderIsOwner } from "openclaw/plugin-sdk/routing";
import { resolveWhatsAppInboundPolicy } from "./inbound-policy.js";
import {
  isWhatsAppGroupJid,
  isWhatsAppNewsletterJid,
  normalizeWhatsAppAllowFromEntry,
  normalizeWhatsAppTarget,
} from "./normalize.js";

export function resolveWhatsAppOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const normalized = normalizeWhatsAppTarget(params.target);
  if (!normalized) {
    return null;
  }
  const isGroup = isWhatsAppGroupJid(normalized);
  const isNewsletter = isWhatsAppNewsletterJid(normalized);
  const chatType = isGroup ? "group" : isNewsletter ? "channel" : "direct";
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "whatsapp",
    accountId: params.accountId,
    peer: {
      kind: chatType,
      id: normalized,
    },
    chatType,
    from: normalized,
    to: normalized,
  });
}

export async function resolveWhatsAppCurrentConversationRoute(
  params: ChannelCurrentConversationRouteParams,
) {
  const normalized = normalizeWhatsAppTarget(params.target);
  if (!normalized) {
    return null;
  }
  const targetChatType = isWhatsAppGroupJid(normalized)
    ? "group"
    : isWhatsAppNewsletterJid(normalized)
      ? "channel"
      : "direct";
  if (targetChatType !== params.chatType) {
    return null;
  }
  const policy = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const route = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    route: resolveAgentRoute({
      cfg: params.cfg,
      channel: "whatsapp",
      accountId: policy.account.accountId,
      peer: { kind: targetChatType, id: normalized },
    }),
    channel: "whatsapp",
    accountId: policy.account.accountId,
    conversationId: normalized,
  }).route;
  if (targetChatType !== "direct") {
    return route;
  }
  const senderId = normalizeWhatsAppTarget(params.senderId ?? "");
  if (!senderId || senderId !== normalized) {
    return null;
  }
  const pairedAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "whatsapp",
    accountId: policy.account.accountId,
    dmPolicy: policy.dmPolicy,
  });
  return {
    ...route,
    senderIsOwner: resolveStableSenderIsOwner({
      senderId,
      commandOwnerAllowFrom: params.cfg.commands?.ownerAllowFrom,
      providerAllowFrom: [...policy.dmAllowFrom, ...pairedAllowFrom],
      normalizeEntry: normalizeWhatsAppAllowFromEntry,
    }),
  };
}
