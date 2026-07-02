/** Lazy channel-plugin route resolution for persisted cron sessions. */
import type { ChatType } from "../../channels/chat-type.js";
import type { ChannelCurrentConversationRoute } from "../../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";

export type CronPluginConversationRouteResult =
  | { kind: "unsupported" }
  | { kind: "unresolved" }
  | { kind: "resolved"; route: ChannelCurrentConversationRoute };

export async function resolveCronPluginConversationRoute(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  target: string;
  conversationId?: string | null;
  chatType: ChatType;
  threadId?: string | number | null;
  senderId?: string | null;
}): Promise<CronPluginConversationRouteResult> {
  const plugin = resolveOutboundChannelPlugin({
    channel: params.channel,
    cfg: params.cfg,
    allowBootstrap: true,
  });
  const resolver = plugin?.messaging?.resolveCurrentConversationRoute;
  if (!resolver) {
    return { kind: "unsupported" };
  }
  const route = await resolver(params);
  return route ? { kind: "resolved", route } : { kind: "unresolved" };
}
