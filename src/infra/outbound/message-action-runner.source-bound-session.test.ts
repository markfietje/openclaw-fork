import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const mocks = vi.hoisted(() => ({
  ensureOutboundSessionEntry: vi.fn(),
  executePollAction: vi.fn(),
  executeSendAction: vi.fn(async () => ({
    handledBy: "core" as const,
    payload: { ok: true },
  })),
  resolveOutboundSessionRoute: vi.fn(async () => ({
    sessionKey: "agent:main:slack:channel:C123",
    baseSessionKey: "agent:main:slack:channel:C123",
    peer: { kind: "channel" as const, id: "C123" },
    chatType: "channel" as const,
    from: "slack:channel:C123",
    to: "channel:C123",
  })),
}));

vi.mock("./outbound-session.js", () => ({
  ensureOutboundSessionEntry: mocks.ensureOutboundSessionEntry,
  resolveOutboundSessionRoute: mocks.resolveOutboundSessionRoute,
}));

vi.mock("./outbound-send-service.js", () => ({
  executePollAction: mocks.executePollAction,
  executeSendAction: mocks.executeSendAction,
}));

function registerSlackPlugin(options?: { gatewayActions?: boolean }) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "slack",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn(),
            },
          }),
          actions: {
            prepareSendPayload: ({ payload }: { payload: ReplyPayload }) => payload,
            ...(options?.gatewayActions ? { resolveExecutionMode: () => "gateway" as const } : {}),
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({ enabled: true }),
            isConfigured: () => true,
          },
          threading: {
            resolveAutoThreadId: () => "root-1",
          },
        },
      },
    ]),
  );
}

const cfg = {
  channels: { slack: { enabled: true } },
} as OpenClawConfig;

describe("source-bound message action session isolation", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
  });

  it("inherits transport threading without resolving, ensuring, or mirroring an owner session", async () => {
    registerSlackPlugin();

    await runMessageAction({
      cfg,
      action: "send",
      params: { message: "safe observation" },
      agentId: "main",
      sessionId: "owner-session-id",
      sessionKey: "agent:main:slack:channel:C123",
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
        currentThreadTs: "root-1",
      },
      sourceReplyDeliveryMode: "message_tool_only",
      sourceBoundMessagePolicy: {
        mode: "source_bound",
        channel: "slack",
        accountId: "default",
        conversationId: "C123",
        threadId: "root-1",
      },
      dryRun: false,
    });

    expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(mocks.ensureOutboundSessionEntry).not.toHaveBeenCalled();
    expect(mocks.executeSendAction).toHaveBeenCalledOnce();
    expect(mocks.executeSendAction).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "root-1",
        ctx: expect.not.objectContaining({
          sessionKey: expect.anything(),
          sessionId: expect.anything(),
          mirror: expect.anything(),
        }),
      }),
    );
  });

  it("fails closed before gateway-owned channel actions", async () => {
    registerSlackPlugin({ gatewayActions: true });

    await expect(
      runMessageAction({
        cfg,
        action: "send",
        params: { message: "safe observation" },
        sessionKey: "agent:main:slack:channel:C123",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
        },
        sourceBoundMessagePolicy: {
          mode: "source_bound",
          channel: "slack",
          accountId: "default",
          conversationId: "C123",
        },
        dryRun: false,
      }),
    ).rejects.toThrow("requires direct channel delivery");
    expect(mocks.executeSendAction).not.toHaveBeenCalled();
  });
});
