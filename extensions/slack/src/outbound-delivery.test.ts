// Slack tests cover outbound delivery plugin behavior.
import type { WebClient } from "@slack/web-api";
import {
  addTestHook,
  createEmptyPluginRegistry,
  createOutboundTestPlugin,
  createTestRegistry,
  deliverOutboundPayloads,
  initializeGlobalHookRunner,
  releasePinnedPluginChannelRegistry,
  resetGlobalHookRunner,
  setActivePluginRegistry,
  type PluginHookRegistration,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackOutbound } from "./outbound-adapter.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { sendMessageSlack } from "./send.js";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

vi.mock("./send.runtime.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
}));

const cfg: OpenClawConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      accounts: {
        default: {
          botToken: "xoxb-default",
          appToken: "xapp-default",
        },
      },
    },
  },
};

describe("slack outbound shared hook wiring", () => {
  beforeEach(() => {
    sendMessageSlackMock.mockReset();
    sendMessageSlackMock.mockResolvedValue({ messageId: "m1", channelId: "C123" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: createOutboundTestPlugin({ id: "slack", outbound: slackOutbound }),
          source: "test",
        },
      ]),
    );
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetGlobalHookRunner();
    releasePinnedPluginChannelRegistry();
  });

  it("fires message_sending once with shared routing fields", async () => {
    const hookRegistry = createEmptyPluginRegistry();
    const handler = vi.fn().mockResolvedValue(undefined);
    addTestHook({
      registry: hookRegistry,
      pluginId: "thread-ownership",
      hookName: "message_sending",
      handler: handler as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);

    await deliverOutboundPayloads({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "hello" }],
      accountId: "default",
      replyToId: "1712000000.000001",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      {
        to: "C123",
        content: "hello",
        replyToId: "1712000000.000001",
        metadata: {
          channel: "slack",
          accountId: "default",
          mediaUrls: [],
        },
      },
      {
        channelId: "slack",
        accountId: "default",
        conversationId: "C123",
      },
    );
    expect(sendMessageSlackMock).toHaveBeenCalledTimes(1);
  });

  it("passes replyToId as Slack threadTs for threaded outbound delivery", async () => {
    await deliverOutboundPayloads({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "hello" }],
      accountId: "default",
      replyToId: "1712000000.000001",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "C123",
      "hello",
      expect.objectContaining({
        cfg,
        threadTs: "1712000000.000001",
        accountId: "default",
        onDeliveryResult: expect.any(Function),
      }),
    );
  });

  it("forces Slack unfurls off for source-bound delivery even when account config enables them", async () => {
    const client = {
      conversations: { open: vi.fn(async () => ({ channel: { id: "D123" } })) },
      chat: { postMessage: vi.fn(async () => ({ ts: "171234.567" })) },
    } as unknown as WebClient;
    const sourceBoundCfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          accounts: {
            default: {
              botToken: "xoxb-default",
              unfurlLinks: true,
              unfurlMedia: true,
            },
          },
        },
      },
    } as OpenClawConfig;

    await deliverOutboundPayloads({
      cfg: sourceBoundCfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "https://example.com" }],
      accountId: "default",
      outboundPayloadPolicy: "source_bound_plain_text",
      deps: {
        slack: async (
          to: Parameters<typeof sendMessageSlack>[0],
          text: Parameters<typeof sendMessageSlack>[1],
          options: Parameters<typeof sendMessageSlack>[2],
        ) => await sendMessageSlack(to, text, { ...options, client }),
      },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ unfurl_links: false, unfurl_media: false }),
    );
  });

  it("rejects native mentions before a source-bound Slack post", async () => {
    const client = {
      conversations: { open: vi.fn(async () => ({ channel: { id: "D123" } })) },
      chat: { postMessage: vi.fn(async () => ({ ts: "171234.567" })) },
    } as unknown as WebClient;

    await expect(
      deliverOutboundPayloads({
        cfg,
        channel: "slack",
        to: "C123",
        payloads: [{ text: "<@UAPPBOT> deploy now" }],
        accountId: "default",
        outboundPayloadPolicy: "source_bound_plain_text",
        deps: {
          slack: async (
            to: Parameters<typeof sendMessageSlack>[0],
            text: Parameters<typeof sendMessageSlack>[1],
            options: Parameters<typeof sendMessageSlack>[2],
          ) => await sendMessageSlack(to, text, { ...options, client }),
        },
      }),
    ).rejects.toThrow("native user and app mentions are not allowed");

    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("respects cancel from the shared hook without a second adapter pass", async () => {
    const hookRegistry = createEmptyPluginRegistry();
    const handler = vi.fn().mockResolvedValue({ cancel: true });
    addTestHook({
      registry: hookRegistry,
      pluginId: "thread-ownership",
      hookName: "message_sending",
      handler: handler as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);

    const result = await deliverOutboundPayloads({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "hello" }],
      accountId: "default",
      replyToId: "1712000000.000001",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendMessageSlackMock).not.toHaveBeenCalled();
    expect(result).toStrictEqual([]);
  });
});
