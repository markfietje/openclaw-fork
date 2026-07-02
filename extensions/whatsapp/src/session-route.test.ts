// Whatsapp tests cover session route plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const readStoreAllowFromForDmPolicyMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-policy", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-policy")>(
    "openclaw/plugin-sdk/channel-policy",
  );
  return {
    ...actual,
    readStoreAllowFromForDmPolicy: (...args: unknown[]) =>
      readStoreAllowFromForDmPolicyMock(...args),
  };
});

import {
  resolveWhatsAppCurrentConversationRoute,
  resolveWhatsAppOutboundSessionRoute,
} from "./session-route.js";

beforeEach(() => {
  readStoreAllowFromForDmPolicyMock.mockReset().mockResolvedValue([]);
});

describe("resolveWhatsAppOutboundSessionRoute", () => {
  it("routes newsletter JIDs as channel sessions", () => {
    const route = resolveWhatsAppOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "120363401234567890@newsletter",
    });

    expect(route).toEqual({
      sessionKey: "agent:main:whatsapp:channel:120363401234567890@newsletter",
      baseSessionKey: "agent:main:whatsapp:channel:120363401234567890@newsletter",
      peer: {
        kind: "channel",
        id: "120363401234567890@newsletter",
      },
      chatType: "channel",
      from: "120363401234567890@newsletter",
      to: "120363401234567890@newsletter",
    });
  });

  it("keeps direct user targets on direct session semantics", () => {
    const route = resolveWhatsAppOutboundSessionRoute({
      cfg: { session: { dmScope: "per-channel-peer" } },
      agentId: "main",
      target: "+15551234567",
    });

    expect(route).toEqual({
      sessionKey: "agent:main:whatsapp:direct:+15551234567",
      baseSessionKey: "agent:main:whatsapp:direct:+15551234567",
      peer: {
        kind: "direct",
        id: "+15551234567",
      },
      chatType: "direct",
      from: "+15551234567",
      to: "+15551234567",
    });
  });
});

describe("resolveWhatsAppCurrentConversationRoute", () => {
  const baseCfg = {
    agents: { list: [{ id: "main", default: true }] },
    session: { dmScope: "per-channel-peer" as const },
    channels: { whatsapp: { dmPolicy: "pairing" as const, allowFrom: [] } },
  };

  it("carries exact pairing approval into current direct owner proof", async () => {
    readStoreAllowFromForDmPolicyMock.mockResolvedValue(["+15551234567"]);

    const route = await resolveWhatsAppCurrentConversationRoute({
      cfg: baseCfg,
      accountId: "default",
      target: "+15551234567",
      chatType: "direct",
      senderId: "whatsapp:+15551234567",
    });

    expect(readStoreAllowFromForDmPolicyMock).toHaveBeenCalledWith({
      provider: "whatsapp",
      accountId: "default",
      dmPolicy: "pairing",
    });
    expect(route).toMatchObject({
      sessionKey: "agent:main:whatsapp:direct:+15551234567",
      senderIsOwner: true,
    });
  });

  it("does not turn wildcard pairing approval into owner proof", async () => {
    readStoreAllowFromForDmPolicyMock.mockResolvedValue(["*"]);

    const route = await resolveWhatsAppCurrentConversationRoute({
      cfg: baseCfg,
      accountId: "default",
      target: "+15551234567",
      chatType: "direct",
      senderId: "+15551234567",
    });

    expect(route?.senderIsOwner).toBe(false);
  });

  it("does not turn open direct access into owner proof", async () => {
    const route = await resolveWhatsAppCurrentConversationRoute({
      cfg: {
        ...baseCfg,
        channels: { whatsapp: { dmPolicy: "open", allowFrom: ["*"] } },
      },
      accountId: "default",
      target: "+15551234567",
      chatType: "direct",
      senderId: "+15551234567",
    });

    expect(readStoreAllowFromForDmPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({ dmPolicy: "open" }),
    );
    expect(route?.senderIsOwner).toBe(false);
  });

  it("rejects a direct route whose persisted sender differs from its target", async () => {
    await expect(
      resolveWhatsAppCurrentConversationRoute({
        cfg: baseCfg,
        accountId: "default",
        target: "+15551234567",
        chatType: "direct",
        senderId: "+15557654321",
      }),
    ).resolves.toBeNull();
    expect(readStoreAllowFromForDmPolicyMock).not.toHaveBeenCalled();
  });
});
