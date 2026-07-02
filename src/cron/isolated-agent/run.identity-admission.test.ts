import { describe, expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  ensureAgentWorkspaceMock,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveCronConversationIdentityContextMock,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
  runCliAgentMock,
  updateSessionStoreMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn identity admission", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("denies a stale persistent identity before workspace, session, message, or usage state", async () => {
    resolveCronConversationIdentityContextMock.mockReturnValue({
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "service",
        sessionKey: "agent:service:chat:group:room-1",
        job: makeIsolatedAgentJobFixture({
          agentId: "service",
          sessionTarget: "session:agent:service:chat:group:room-1",
        }),
      }),
    );

    expect(result).toMatchObject({
      status: "skipped",
      error: "cron conversation identity denied: stale_route",
      sessionKey: "agent:service:chat:group:room-1",
    });
    expect(ensureAgentWorkspaceMock).not.toHaveBeenCalled();
    expect(resolveCronSessionMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("carries the admitted service identity and policy inputs into the embedded run", async () => {
    const decision = {
      mode: "organization",
      allowed: true,
      reason: "bound_service_agent",
    } as const;
    resolveCronConversationIdentityContextMock.mockReturnValue({
      decision,
      routeMatchedBy: "binding.team",
      messageProvider: "chat",
      chatType: "group",
      agentAccountId: "work",
      groupId: "room-1",
      groupChannel: "#operations",
      groupSpace: "team-1",
      senderId: "member-1",
      senderIsOwner: false,
    });
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "service",
        sessionKey: "agent:service:chat:group:room-1",
        job: makeIsolatedAgentJobFixture({
          agentId: "service",
          sessionTarget: "session:agent:service:chat:group:room-1",
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationIdentity: decision,
        routeMatchedBy: "binding.team",
        messageProvider: "chat",
        policyMessageProvider: "chat",
        chatType: "group",
        agentAccountId: "work",
        groupId: "room-1",
        groupChannel: "#operations",
        groupSpace: "team-1",
        senderId: "member-1",
        senderIsOwner: false,
      }),
    );
  });

  it("keeps admitted source policy separate from CLI delivery transport", async () => {
    resolveCronConversationIdentityContextMock.mockReturnValue({
      decision: {
        mode: "organization",
        allowed: true,
        reason: "bound_service_agent",
      },
      routeMatchedBy: "binding.peer",
      messageProvider: "slack",
      chatType: "channel",
      agentAccountId: "work",
      groupId: "room-1",
      senderId: "member-1",
    });
    isCliProviderMock.mockReturnValue(true);
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "service",
        sessionKey: "agent:service:slack:channel:room-1",
        job: makeIsolatedAgentJobFixture({
          agentId: "service",
          sessionTarget: "session:agent:service:slack:channel:room-1",
          delivery: { mode: "announce", channel: "messagechat", to: "test-target" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageChannel: "messagechat",
        messageProvider: "slack",
        policyMessageProvider: "slack",
      }),
    );
  });
});
