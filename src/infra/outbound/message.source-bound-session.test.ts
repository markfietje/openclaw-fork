import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { sendMessage } from "./message.js";

const mocks = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async () => ({ status: "sent" as const, results: [] })),
}));

vi.mock("../../channels/message/runtime.js", () => ({
  sendDurableMessageBatch: mocks.sendDurableMessageBatch,
}));

function registerPlugin(deliveryMode: "direct" | "gateway") {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "slack",
          outbound: {
            deliveryMode,
            sendText: vi.fn(),
          },
        }),
      },
    ]),
  );
}

const cfg = {
  channels: { slack: { enabled: true } },
} as OpenClawConfig;

describe("source-bound durable session isolation", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
  });

  it("drops owner session and transcript mirror metadata before enqueue", async () => {
    registerPlugin("direct");

    await sendMessage({
      cfg,
      channel: "slack",
      accountId: "default",
      to: "channel:C123",
      content: "safe observation",
      agentId: "main",
      requesterSessionKey: "agent:main:slack:channel:C123",
      requesterAccountId: "default",
      requesterSenderId: "U123",
      mirror: {
        sessionKey: "agent:main:slack:channel:C123",
        agentId: "main",
        text: "safe observation",
      },
      queuePolicy: "best_effort",
      outboundPayloadPolicy: "source_bound_plain_text",
    });

    expect(mocks.sendDurableMessageBatch).toHaveBeenCalledOnce();
    expect(mocks.sendDurableMessageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        outboundPayloadPolicy: "source_bound_plain_text",
        session: undefined,
        mirror: undefined,
      }),
    );
  });

  it("rejects gateway delivery before queue or network dispatch", async () => {
    registerPlugin("gateway");

    await expect(
      sendMessage({
        cfg,
        channel: "slack",
        to: "channel:C123",
        content: "safe observation",
        queuePolicy: "required",
        outboundPayloadPolicy: "source_bound_plain_text",
      }),
    ).rejects.toThrow("requires direct channel delivery");
    expect(mocks.sendDurableMessageBatch).not.toHaveBeenCalled();
  });
});
