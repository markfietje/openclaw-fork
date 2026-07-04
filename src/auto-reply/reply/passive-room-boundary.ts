import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isValidSourceBoundMessagePolicy } from "../../infra/outbound/source-bound-message-policy.js";
import { normalizeInputProvenance } from "../../sessions/input-provenance.js";
import type { SourceBoundMessagePolicy } from "../get-reply-options.types.js";
import type { MsgContext } from "../templating.js";

const PASSIVE_ROOM_BOUNDARY_ERROR_PREFIX = "Passive room turn rejected";

function normalizeRouteValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return normalizeOptionalString(value);
}

function normalizeChannel(value: unknown): string | undefined {
  return normalizeRouteValue(value)?.toLowerCase();
}

function denyPassiveRoomTurn(reason: string): never {
  throw new Error(`${PASSIVE_ROOM_BOUNDARY_ERROR_PREFIX}: ${reason}`);
}

/**
 * Treats RequestAuthorized=false as an authoritative security fact. Passive
 * execution is allowed only when the inbound provenance and immutable reply
 * route form one complete, matching source boundary.
 */
export function assertPassiveRoomTurnBoundary(params: {
  ctx: Pick<
    MsgContext,
    | "RequestAuthorized"
    | "InputProvenance"
    | "OriginatingChannel"
    | "Provider"
    | "Surface"
    | "AccountId"
    | "NativeChannelId"
    | "ChatId"
    | "MessageThreadId"
    | "TransportThreadId"
  >;
  sourceBoundMessagePolicy?: SourceBoundMessagePolicy;
}): void {
  if (params.ctx.RequestAuthorized !== false) {
    return;
  }

  const provenance = normalizeInputProvenance(params.ctx.InputProvenance);
  if (provenance?.kind !== "room_observation") {
    denyPassiveRoomTurn("RequestAuthorized=false requires room_observation provenance");
  }
  const policy = params.sourceBoundMessagePolicy;
  if (!policy || !isValidSourceBoundMessagePolicy(policy)) {
    denyPassiveRoomTurn("RequestAuthorized=false requires a complete source-bound message policy");
  }

  const provenanceChannel = normalizeChannel(provenance.sourceChannel);
  const inboundChannel = normalizeChannel(
    params.ctx.OriginatingChannel ?? params.ctx.Provider ?? params.ctx.Surface,
  );
  const policyChannel = normalizeChannel(policy.channel);
  if (
    !provenanceChannel ||
    !inboundChannel ||
    provenanceChannel !== policyChannel ||
    inboundChannel !== policyChannel
  ) {
    denyPassiveRoomTurn("room_observation provenance does not match the source-bound channel");
  }

  const inboundAccountId = normalizeRouteValue(params.ctx.AccountId);
  if (!inboundAccountId || inboundAccountId !== normalizeRouteValue(policy.accountId)) {
    denyPassiveRoomTurn("inbound account does not match the source-bound account");
  }

  const inboundConversationId = normalizeRouteValue(
    params.ctx.NativeChannelId ?? params.ctx.ChatId,
  );
  if (
    !inboundConversationId ||
    inboundConversationId !== normalizeRouteValue(policy.conversationId)
  ) {
    denyPassiveRoomTurn("inbound conversation does not match the source-bound conversation");
  }

  const inboundThreadId = normalizeRouteValue(
    params.ctx.MessageThreadId ?? params.ctx.TransportThreadId,
  );
  if (inboundThreadId !== normalizeRouteValue(policy.threadId)) {
    denyPassiveRoomTurn("inbound thread does not match the source-bound thread");
  }
}
