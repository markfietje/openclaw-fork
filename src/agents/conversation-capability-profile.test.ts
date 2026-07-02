import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isInterSessionIdentityTransitionAllowed,
  resolveConversationIdentityMode,
  resolveStableSenderIsOwner,
} from "../routing/conversation-identity.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";

const identityConfig: OpenClawConfig = {
  agents: {
    list: [{ id: "personal", default: true }, { id: "team-ops" }],
  },
};

describe("resolveConversationCapabilityProfile", () => {
  it("prepares a direct conversation profile with sender tool restrictions", () => {
    const cfg: OpenClawConfig = {
      tools: {
        toolsBySender: {
          "id:guest": { deny: ["exec", "process"] },
        },
      },
      agents: identityConfig.agents,
    };

    const profile = resolveConversationCapabilityProfile({
      config: cfg,
      sessionKey: "agent:main:discord:dm:guest",
      agentId: "personal",
      routeMatchedBy: "default",
      messageProvider: "discord",
      chatType: "direct",
      senderId: "guest",
      senderIsOwner: true,
      modelProvider: "openai",
      modelId: "gpt-5.5",
      modelApi: "responses",
      workspaceDir: "/tmp/openclaw-direct-profile",
      cwd: "/tmp/openclaw-direct-profile/task",
      agentDir: "/tmp/openclaw-agent-direct-profile",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "ops" }],
      },
    });

    expect(profile.conversation.scope).toBe("direct");
    expect(profile.conversation.identity).toEqual({
      mode: "personal",
      allowed: true,
      reason: "owner_direct",
    });
    expect(profile.policy.senderPolicy).toEqual({ deny: ["exec", "process"] });
    expect(profile.policy.explicitToolDenylist).toEqual(["exec", "process"]);
    expect(profile.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.5",
      api: "responses",
    });
    expect(profile.workspace).toMatchObject({
      workspaceRoot: "/tmp/openclaw-direct-profile",
      runtimeRoot: "/tmp/openclaw-direct-profile/task",
      instructionRoot: "/tmp/openclaw-agent-direct-profile",
    });
    expect(profile.skills.snapshot?.skills).toEqual([{ name: "ops" }]);
  });

  it.each([
    { provider: "slack", routeMatchedBy: "binding.team" as const, groupSpace: "T123" },
    { provider: "discord", routeMatchedBy: "binding.guild" as const, groupSpace: "G123" },
  ])(
    "prepares an organization profile from generic $provider binding metadata",
    ({ provider, routeMatchedBy, groupSpace }) => {
      const cfg: OpenClawConfig = {
        agents: identityConfig.agents,
        tools: {
          toolsBySender: {
            "id:alice": { deny: ["exec", "process"] },
          },
        },
      };

      const profile = resolveConversationCapabilityProfile({
        config: cfg,
        sessionKey: `agent:team-ops:${provider}:channel:team`,
        agentId: "team-ops",
        routeMatchedBy,
        messageProvider: provider,
        chatType: "channel",
        groupSpace,
        senderId: "alice",
        modelProvider: "openai",
        modelId: "gpt-5.5",
        workspaceDir: "/tmp/openclaw-shared-profile",
      });

      expect(profile.conversation).toMatchObject({
        scope: "shared",
        routeMatchedBy,
        identity: {
          mode: "organization",
          allowed: true,
          reason: "bound_service_agent",
        },
      });
      expect(profile.policy.senderPolicy).toEqual({ deny: ["exec", "process"] });
      expect(profile.policy.explicitToolDenylist).toEqual(["exec", "process"]);
    },
  );

  it("keeps admitted source policy when delivery uses another channel", () => {
    const profile = resolveConversationCapabilityProfile({
      config: {
        agents: identityConfig.agents,
        tools: {
          toolsBySender: {
            "channel:slack:member-1": { deny: ["exec"] },
            "channel:telegram:member-1": { deny: ["web_search"] },
          },
        },
      },
      sessionKey: "agent:team-ops:slack:channel:C123",
      agentId: "team-ops",
      routeMatchedBy: "binding.peer",
      messageProvider: "slack",
      messageChannel: "telegram",
      policyMessageProvider: "slack",
      chatType: "channel",
      senderId: "member-1",
    });

    expect(profile.policy.senderPolicy).toEqual({ deny: ["exec"] });
    expect(profile.policy.explicitToolDenylist).toContain("exec");
    expect(profile.policy.explicitToolDenylist).not.toContain("web_search");
  });

  it.each([
    {
      name: "an unbound shared audience",
      agentId: "personal",
      routeMatchedBy: "default" as const,
      chatType: "channel",
      senderIsOwner: true,
    },
    {
      name: "a guest direct message",
      agentId: "personal",
      routeMatchedBy: "default" as const,
      chatType: "direct",
      senderIsOwner: false,
      senderName: "Personal Owner",
    },
    {
      name: "an explicit shared binding to the personal agent",
      agentId: "personal",
      routeMatchedBy: "binding.guild" as const,
      chatType: "channel",
      senderIsOwner: true,
    },
    {
      name: "a fallback route that names a service agent",
      agentId: "team-ops",
      routeMatchedBy: "default" as const,
      chatType: "channel",
      senderIsOwner: true,
    },
    {
      name: "a service agent without binding provenance",
      agentId: "team-ops",
      routeMatchedBy: undefined,
      chatType: "channel",
      senderIsOwner: true,
    },
    {
      name: "an unknown account-selected service agent",
      agentId: "typo-service",
      routeMatchedBy: "config.agent" as const,
      chatType: "channel",
      senderIsOwner: true,
    },
    {
      name: "a stale runtime binding to a removed service agent",
      agentId: "removed-service",
      routeMatchedBy: "binding.channel" as const,
      chatType: "channel",
      senderIsOwner: true,
    },
  ])("denies $name without personal fallback", (params) => {
    expect(
      resolveConversationIdentityMode({
        config: identityConfig,
        ...params,
      }),
    ).toMatchObject({ mode: "external", allowed: false });
  });

  it("allows a configured account-selected service agent for a shared audience", () => {
    expect(
      resolveConversationIdentityMode({
        config: identityConfig,
        agentId: "team-ops",
        routeMatchedBy: "config.agent",
        chatType: "channel",
      }),
    ).toEqual({ mode: "organization", allowed: true, reason: "bound_service_agent" });
  });

  it("derives personal ownership only from an explicit stable sender allowlist", () => {
    const normalizeEntry = (entry: string) =>
      entry
        .trim()
        .replace(/^test:/, "")
        .toLowerCase();

    expect(
      resolveStableSenderIsOwner({
        senderId: "OWNER",
        providerAllowFrom: ["test:owner"],
        normalizeEntry,
      }),
    ).toBe(true);
    expect(
      resolveStableSenderIsOwner({
        senderId: "guest",
        providerAllowFrom: ["*"],
        normalizeEntry,
      }),
    ).toBe(false);
    expect(
      resolveStableSenderIsOwner({
        senderId: "OWNER",
        commandOwnerAllowFrom: ["*"],
        providerAllowFrom: ["test:owner"],
        normalizeEntry,
      }),
    ).toBe(true);
    expect(
      resolveStableSenderIsOwner({
        senderId: "paired-user",
        providerAllowFrom: [],
        normalizeEntry,
      }),
    ).toBe(false);
  });

  it("allows an explicit service binding when agents use the implicit legacy registry", () => {
    expect(
      resolveConversationIdentityMode({
        config: {
          bindings: [{ agentId: "team-ops", match: { channel: "slack" } }],
        },
        agentId: "team-ops",
        routeMatchedBy: "binding.channel",
        chatType: "channel",
      }),
    ).toEqual({ mode: "organization", allowed: true, reason: "bound_service_agent" });
  });

  it("revokes a legacy service route after its owning binding is removed", () => {
    expect(
      resolveConversationIdentityMode({
        config: {},
        agentId: "team-ops",
        routeMatchedBy: "binding.channel",
        chatType: "channel",
      }),
    ).toEqual({ mode: "external", allowed: false, reason: "unconfigured_agent" });
  });

  it("keeps trusted internal turns inside their admitted session", () => {
    expect(
      resolveConversationIdentityMode({
        config: identityConfig,
        isInternal: true,
        agentId: "personal",
        routeMatchedBy: "default",
        chatType: "channel",
      }),
    ).toEqual({ mode: "personal", allowed: true, reason: "internal" });
  });

  it("carries the owning ingress decision without reclassifying a scheduled turn", () => {
    const decision = {
      mode: "organization",
      allowed: true,
      reason: "bound_service_agent",
    } as const;
    const profile = resolveConversationCapabilityProfile({
      config: identityConfig,
      conversationIdentity: decision,
      agentId: "team-ops",
      isInternal: true,
      workspaceDir: "/tmp/openclaw-scheduled-profile",
    });

    expect(profile.conversation.identity).toBe(decision);
  });

  it("rejects trusted internal turns targeting a removed agent", () => {
    expect(
      resolveConversationIdentityMode({
        config: identityConfig,
        isInternal: true,
        agentId: "removed-service",
        routeMatchedBy: "binding.channel",
        chatType: "channel",
      }),
    ).toEqual({ mode: "external", allowed: false, reason: "unconfigured_agent" });
  });

  it.each([
    {
      name: "personal to service",
      sourceSessionKey: "agent:personal:main",
      targetAgentId: "team-ops",
      allowed: true,
    },
    {
      name: "service to same service",
      sourceSessionKey: "agent:team-ops:slack:channel:C1",
      targetAgentId: "team-ops",
      allowed: true,
    },
    {
      name: "service to personal",
      sourceSessionKey: "agent:team-ops:slack:channel:C1",
      targetAgentId: "personal",
      allowed: false,
    },
    {
      name: "unscoped source to personal",
      sourceSessionKey: "unknown",
      targetAgentId: "personal",
      allowed: false,
    },
  ])(
    "classifies $name inter-session transitions",
    ({ sourceSessionKey, targetAgentId, allowed }) => {
      expect(
        isInterSessionIdentityTransitionAllowed({
          config: identityConfig,
          sourceSessionKey,
          sourceTool: "sessions_send",
          targetAgentId,
        }),
      ).toBe(allowed);
    },
  );

  it("keeps trusted background completion tools inside their target session", () => {
    expect(
      isInterSessionIdentityTransitionAllowed({
        config: identityConfig,
        sourceSessionKey: "image_generate:task-1",
        sourceTool: "image_generate",
        targetAgentId: "personal",
      }),
    ).toBe(true);
  });

  it("rejects inter-session completion targeting a removed agent", () => {
    expect(
      isInterSessionIdentityTransitionAllowed({
        config: identityConfig,
        sourceSessionKey: "image_generate:task-1",
        sourceTool: "image_generate",
        targetAgentId: "removed-service",
      }),
    ).toBe(false);
  });

  it("fails closed when an external ingress omits audience metadata", () => {
    expect(
      resolveConversationIdentityMode({
        config: identityConfig,
        agentId: "personal",
        routeMatchedBy: "default",
      }),
    ).toEqual({ mode: "external", allowed: false, reason: "unknown_audience" });
  });

  it("uses the canonical channel for sender policy on a tool-policy sub-surface", () => {
    const profile = resolveConversationCapabilityProfile({
      config: {
        agents: identityConfig.agents,
        tools: {
          toolsBySender: {
            "channel:discord:speaker-1": { deny: ["exec"] },
          },
        },
      },
      agentId: "team-ops",
      routeMatchedBy: "binding.guild",
      messageProvider: "discord-voice",
      messageChannel: "discord",
      chatType: "channel",
      senderId: "speaker-1",
    });

    expect(profile.conversation.messageProvider).toBe("discord-voice");
    expect(profile.policy.senderPolicy).toEqual({ deny: ["exec"] });
  });
});
