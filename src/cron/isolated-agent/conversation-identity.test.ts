import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronConversationIdentityContext as resolveCronConversationIdentityContextImpl } from "./conversation-identity.js";

const sessionEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "session-1",
  updatedAt: 1,
  ...overrides,
});

const resolveCronConversationIdentityContext = (
  params: Parameters<typeof resolveCronConversationIdentityContextImpl>[0],
) =>
  resolveCronConversationIdentityContextImpl({
    ...params,
    resolvePluginRoute:
      params.resolvePluginRoute ?? (async () => ({ kind: "unsupported" as const })),
  });

describe("resolveCronConversationIdentityContext", () => {
  it("rejects removed agents for isolated and named persistent sessions", async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;

    for (const target of ["isolated", "session:daily"] as const) {
      expect(
        (
          await resolveCronConversationIdentityContext({
            cfg,
            agentId: "removed-service",
            sessionKey: "agent:removed-service:daily",
            sessionTarget: target,
          })
        ).decision,
      ).toEqual({ mode: "external", allowed: false, reason: "unconfigured_agent" });
    }
  });

  it("allows a current service agent in an opaque named session", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "service" }] },
    } as OpenClawConfig;

    expect(
      (
        await resolveCronConversationIdentityContext({
          cfg,
          agentId: "service",
          sessionKey: "agent:service:daily",
          sessionTarget: "session:daily",
        })
      ).decision,
    ).toEqual({ mode: "personal", allowed: true, reason: "internal" });
  });

  it("revalidates a personal direct sender against the current owner policy", async () => {
    const base = {
      agents: { list: [{ id: "main", default: true }] },
      session: { dmScope: "per-channel-peer" },
    } satisfies Partial<OpenClawConfig>;
    const entry = sessionEntry({
      chatType: "direct",
      origin: { provider: "chat", from: "owner-1", accountId: "default" },
    });
    const params = {
      agentId: "main",
      sessionKey: "agent:main:chat:direct:owner-1",
      sessionTarget: "session:agent:main:chat:direct:owner-1" as const,
      sessionEntry: entry,
    };

    expect(
      (
        await resolveCronConversationIdentityContext({
          ...params,
          cfg: { ...base, commands: { ownerAllowFrom: ["owner-1"] } } as OpenClawConfig,
        })
      ).decision,
    ).toEqual({ mode: "personal", allowed: true, reason: "owner_direct" });
    expect(
      (
        await resolveCronConversationIdentityContext({
          ...params,
          cfg: { ...base, commands: { ownerAllowFrom: ["someone-else"] } } as OpenClawConfig,
        })
      ).decision,
    ).toEqual({ mode: "external", allowed: false, reason: "untrusted_direct" });
  });

  it("revalidates compact shared and per-peer direct sessions from persisted metadata", async () => {
    for (const testCase of [
      {
        dmScope: "main" as const,
        sessionKey: "agent:main:main",
        senderId: "U123",
      },
      {
        dmScope: "per-peer" as const,
        sessionKey: "agent:main:direct:u123",
        senderId: "U123",
      },
    ]) {
      const result = await resolveCronConversationIdentityContext({
        cfg: {
          agents: { list: [{ id: "main", default: true }] },
          session: { dmScope: testCase.dmScope },
          commands: { ownerAllowFrom: [`slack:${testCase.senderId}`] },
        } as OpenClawConfig,
        agentId: "main",
        sessionKey: testCase.sessionKey,
        sessionTarget: "current",
        sessionEntry: sessionEntry({
          chatType: "direct",
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "U123", chatType: "direct" },
          },
          origin: {
            provider: "slack",
            from: "slack:U123",
            to: "slack:U123",
            accountId: "default",
          },
        }),
      });

      expect(result).toMatchObject({
        decision: { mode: "personal", allowed: true, reason: "owner_direct" },
        senderId: testCase.senderId,
        senderIsOwner: true,
      });
    }
  });

  it("does not treat an identity-linked session alias as stable owner proof", async () => {
    const result = await resolveCronConversationIdentityContext({
      cfg: {
        agents: { list: [{ id: "main", default: true }] },
        session: {
          dmScope: "per-peer",
          identityLinks: { alice: ["slack:U123"] },
        },
        commands: { ownerAllowFrom: ["alice"] },
      } as OpenClawConfig,
      agentId: "main",
      sessionKey: "agent:main:direct:alice",
      sessionTarget: "current",
      sessionEntry: sessionEntry({
        chatType: "direct",
        route: {
          channel: "slack",
          accountId: "default",
          target: { to: "U123", chatType: "direct" },
        },
        origin: {
          provider: "slack",
          from: "slack:U123",
          to: "slack:U123",
          accountId: "default",
        },
      }),
    });

    expect(result).toMatchObject({
      decision: { mode: "external", allowed: false, reason: "untrusted_direct" },
      senderId: "U123",
      senderIsOwner: false,
    });
  });

  it("fails closed when persisted audience metadata cannot reconstruct a current route", async () => {
    expect(
      (
        await resolveCronConversationIdentityContext({
          cfg: { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig,
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionTarget: "current",
          sessionEntry: sessionEntry({ chatType: "direct" }),
        })
      ).decision,
    ).toEqual({ mode: "external", allowed: false, reason: "stale_route" });
  });

  it("carries team and sender facts for a currently bound service route", async () => {
    const cfg = {
      agents: {
        list: [{ id: "main", default: true }, { id: "service" }],
      },
      bindings: [
        {
          agentId: "service",
          match: { channel: "chat", accountId: "default", teamId: "team-1" },
        },
      ],
    } as OpenClawConfig;

    for (const target of ["current", "session:agent:service:chat:group:room-1"] as const) {
      expect(
        await resolveCronConversationIdentityContext({
          cfg,
          agentId: "service",
          sessionKey: "agent:service:chat:group:room-1",
          sessionTarget: target,
          sessionEntry: sessionEntry({
            chatType: "group",
            groupId: "room-1",
            groupChannel: "#operations",
            space: "team-1",
            origin: { provider: "chat", from: "member-1", accountId: "default" },
          }),
        }),
      ).toMatchObject({
        decision: { mode: "organization", allowed: true, reason: "bound_service_agent" },
        routeMatchedBy: "binding.team",
        messageProvider: "chat",
        chatType: "group",
        agentAccountId: "default",
        groupId: "room-1",
        groupChannel: "#operations",
        groupSpace: "team-1",
        senderId: "member-1",
        senderIsOwner: false,
      });
    }
  });

  it("rejects a removed or rebound service binding as stale", async () => {
    const entry = sessionEntry({
      chatType: "group",
      groupId: "room-1",
      origin: { provider: "chat", from: "member-1", accountId: "default" },
    });
    const makeConfig = (agentId?: string) =>
      ({
        agents: {
          list: [{ id: "main", default: true }, { id: "service" }, { id: "replacement" }],
        },
        bindings: agentId
          ? [
              {
                agentId,
                match: {
                  channel: "chat",
                  accountId: "default",
                  peer: { kind: "group", id: "room-1" },
                },
              },
            ]
          : [],
      }) as OpenClawConfig;

    for (const cfg of [makeConfig(), makeConfig("replacement")]) {
      expect(
        (
          await resolveCronConversationIdentityContext({
            cfg,
            agentId: "service",
            sessionKey: "agent:service:chat:group:room-1",
            sessionTarget: "session:agent:service:chat:group:room-1",
            sessionEntry: entry,
          })
        ).decision,
      ).toEqual({ mode: "external", allowed: false, reason: "stale_route" });
    }
  });

  it("uses a channel-owned current route before the generic binding fallback", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "service" }, { id: "replacement" }] },
    } as OpenClawConfig;
    const params = {
      cfg,
      agentId: "service",
      sessionKey: "agent:service:telegram:group:-100:topic:9",
      sessionTarget: "current" as const,
      sessionEntry: sessionEntry({
        chatType: "group",
        groupId: "-100",
        route: {
          channel: "telegram",
          accountId: "default",
          target: { to: "-100", chatType: "group" },
          thread: { id: 9, kind: "topic" },
        },
        origin: { provider: "telegram", from: "telegram:member-1" },
      }),
    };

    const admitted = await resolveCronConversationIdentityContext({
      ...params,
      resolvePluginRoute: async () => ({
        kind: "resolved",
        route: {
          agentId: "service",
          accountId: "default",
          channel: "telegram",
          sessionKey: params.sessionKey,
          matchedBy: "config.agent",
        },
      }),
    });
    expect(admitted.decision).toEqual({
      mode: "organization",
      allowed: true,
      reason: "bound_service_agent",
    });

    for (const pluginResult of [
      { kind: "unresolved" as const },
      {
        kind: "resolved" as const,
        route: {
          agentId: "replacement",
          accountId: "default",
          channel: "telegram",
          sessionKey: "agent:replacement:telegram:group:-100:topic:9",
          matchedBy: "config.agent" as const,
        },
      },
    ]) {
      expect(
        (
          await resolveCronConversationIdentityContext({
            ...params,
            resolvePluginRoute: async () => pluginResult,
          })
        ).decision,
      ).toEqual({ mode: "external", allowed: false, reason: "stale_route" });
    }
  });

  it("carries channel-owned current pairing approval into direct identity", async () => {
    const result = await resolveCronConversationIdentityContext({
      cfg: {
        agents: { list: [{ id: "main", default: true }] },
        session: { dmScope: "per-channel-peer" },
      } as OpenClawConfig,
      agentId: "main",
      sessionKey: "agent:main:whatsapp:direct:+15550001111",
      sessionTarget: "current",
      sessionEntry: sessionEntry({
        chatType: "direct",
        route: {
          channel: "whatsapp",
          accountId: "default",
          target: { to: "+15550001111", chatType: "direct" },
        },
        origin: {
          provider: "whatsapp",
          from: "whatsapp:+15550001111",
          to: "+15550001111",
          accountId: "default",
        },
      }),
      resolvePluginRoute: async () => ({
        kind: "resolved",
        route: {
          agentId: "main",
          accountId: "default",
          channel: "whatsapp",
          sessionKey: "agent:main:whatsapp:direct:+15550001111",
          matchedBy: "default",
          senderIsOwner: true,
        },
      }),
    });

    expect(result).toMatchObject({
      decision: { mode: "personal", allowed: true, reason: "owner_direct" },
      senderId: "+15550001111",
      senderIsOwner: true,
    });
  });
});
