// Slack tests cover auth.test token handling during provider boot.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackHandlers,
  getSlackTestState,
  resetSlackTestState,
  runSlackMessageOnce,
  startSlackMonitor,
  stopSlackMonitor,
} from "../monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");

beforeEach(() => {
  resetSlackTestState();
});

describe("auth.test boot call", () => {
  it("does not pass the bot token in the call arguments", async () => {
    const monitor = startSlackMonitor(monitorSlackProvider);
    await stopSlackMonitor(monitor);

    const client = getSlackClient();
    expect(client.auth.test).toHaveBeenCalledTimes(1);
    // The SDK serializes every property from the call argument into the POST
    // body.  Passing { token } would leak the bot token into the request
    // payload alongside the Authorization header.
    const firstArg = client.auth.test.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    if (firstArg != null) {
      expect(firstArg).not.toHaveProperty("token");
    }
  });

  it("accepts an authorized user event and replies with the configured user token", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          identityMode: "user",
          appToken: "xapp-test",
          userToken: "xoxp-agent",
          userTokenReadOnly: false,
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          groupPolicy: "open",
          streaming: { mode: "off" },
        },
      },
    });
    const runtimeLog = vi.fn();
    const client = getSlackClient();
    client.auth.test.mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UAGENT",
      user: "agent-user",
      team_id: "T1",
      is_enterprise_install: false,
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "hello" });

    const monitor = startSlackMonitor(monitorSlackProvider, {
      runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
    });
    const handler = await getSlackHandlerOrThrow("message");
    await handler({
      body: {
        api_app_id: "A1",
        team_id: "T1",
        authorizations: [{ is_bot: false, user_id: "UAGENT", team_id: "T1" }],
      },
      event: {
        type: "message",
        user: "USENDER",
        text: "hello",
        ts: "100.000",
        channel: "D1",
        channel_type: "im",
      },
    });
    await stopSlackMonitor(monitor);

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({ token: "xoxp-agent" });
    expect(runtimeLog).not.toHaveBeenCalledWith(
      expect.stringContaining("replace it with a Bot User"),
    );
    expect(getSlackHandlers().has("app_home_opened")).toBe(false);
    expect(getSlackHandlers().has("assistant_thread_started")).toBe(false);
  });

  it("drops user identity events without the matching user authorization", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          identityMode: "user",
          appToken: "xapp-test",
          userToken: "xoxp-agent",
          userTokenReadOnly: false,
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          groupPolicy: "open",
        },
      },
    });
    getSlackClient().auth.test.mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UAGENT",
      team_id: "T1",
      is_enterprise_install: false,
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "unexpected" });

    await runSlackMessageOnce(monitorSlackProvider, {
      body: {
        api_app_id: "A1",
        team_id: "T1",
        authorizations: [{ is_bot: true, user_id: "UAGENT", team_id: "T1" }],
      },
      event: {
        type: "message",
        user: "USENDER",
        text: "hello",
        ts: "100.000",
        channel: "D1",
        channel_type: "im",
      },
    });

    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("accepts a user event whose inline authorization was truncated to another installation", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          identityMode: "user",
          appToken: "xapp-test",
          userToken: "xoxp-agent",
          userTokenReadOnly: false,
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          groupPolicy: "open",
          streaming: { mode: "off" },
        },
      },
    });
    const client = getSlackClient();
    client.auth.test.mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UAGENT",
      team_id: "T1",
      is_enterprise_install: false,
    });
    client.apps.event.authorizations.list.mockResolvedValueOnce({
      authorizations: [{ is_bot: false, user_id: "UAGENT", team_id: "T1" }],
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "hello" });

    await runSlackMessageOnce(monitorSlackProvider, {
      body: {
        api_app_id: "A1",
        team_id: "T1",
        event_context: "EC123",
        authorizations: [{ is_bot: true, user_id: "UBOT", team_id: "T1" }],
      },
      event: {
        type: "message",
        user: "USENDER",
        text: "hello",
        ts: "101.000",
        channel: "D1",
        channel_type: "im",
      },
    });

    expect(client.apps.event.authorizations.list).toHaveBeenCalledWith({
      token: "app-token",
      event_context: "EC123",
      limit: 100,
    });
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("requires an app token for user identity HTTP mode authorization lookups", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          mode: "http",
          identityMode: "user",
          userToken: "xoxp-agent",
          userTokenReadOnly: false,
          signingSecret: "secret-http",
        },
      },
    });

    const monitor = startSlackMonitor(monitorSlackProvider, { appToken: "" });

    await expect(monitor.run).rejects.toThrow("Slack userToken + app tokens missing");
  });

  it("fails user identity startup when auth.test resolves a bot token", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          identityMode: "user",
          appToken: "xapp-test",
          userToken: "xoxb-wrong",
          userTokenReadOnly: false,
        },
      },
    });
    getSlackClient().auth.test.mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UBOT",
      bot_id: "BBOT",
      team_id: "T1",
      is_enterprise_install: false,
    });

    const monitor = startSlackMonitor(monitorSlackProvider);

    await expect(monitor.run).rejects.toThrow(
      "auth.test returned bot_id for a user identity token",
    );
  });

  it("warns when auth.test returns a user id without bot_id", async () => {
    const runtimeLog = vi.fn();
    const client = getSlackClient();
    client.auth.test.mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UUSER",
      user: "human-installer",
      team_id: "T1",
      team: "OpenClaw",
      is_enterprise_install: false,
    });

    const monitor = startSlackMonitor(monitorSlackProvider, {
      botToken: "xoxp-user-token",
      runtime: {
        log: runtimeLog,
        error: vi.fn(),
        exit: vi.fn(),
      },
    });
    await stopSlackMonitor(monitor);

    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("channels.slack.accounts.default.botToken"),
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("replace it with a Bot User OAuth Token"),
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("required-mention channels fail closed"),
    );
  });

  it("does not use a user-token identity as the bot mention target", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          groupPolicy: "open",
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    });
    const client = getSlackClient();
    client.auth.test.mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UUSER",
      user: "human-installer",
      team_id: "T1",
      team: "OpenClaw",
      is_enterprise_install: false,
    });
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "unexpected" });

    await runSlackMessageOnce(
      monitorSlackProvider,
      {
        event: {
          type: "message",
          user: "USENDER",
          text: "<@UUSER> status",
          ts: "100.000",
          channel: "C1",
          channel_type: "channel",
        },
      },
      { botToken: "xoxp-user-token" },
    );

    expect(replyMock).not.toHaveBeenCalled();
  });

  it("warns that required-mention channels fail closed when auth.test fails", async () => {
    const runtimeLog = vi.fn();
    getSlackClient().auth.test.mockRejectedValueOnce(new Error("request_timeout"));

    const monitor = startSlackMonitor(monitorSlackProvider, {
      runtime: {
        log: runtimeLog,
        error: vi.fn(),
        exit: vi.fn(),
      },
    });
    await stopSlackMonitor(monitor);

    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining(
        "required-mention channels will fail closed without another trusted activation signal",
      ),
    );
  });

  it("preserves workspace startup when auth.test omits app_id", async () => {
    getSlackClient().auth.test.mockResolvedValueOnce({
      user_id: "UBOT",
      bot_id: "BBOT",
      team_id: "T1",
      is_enterprise_install: false,
    });

    const monitor = startSlackMonitor(monitorSlackProvider);
    await expect(stopSlackMonitor(monitor)).resolves.toBeUndefined();
  });

  it("starts an org-wide Socket Mode account when auth.test omits app_id", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          enterpriseOrgInstall: true,
          dmPolicy: "disabled",
          groupPolicy: "open",
        },
      },
    });
    getSlackClient().auth.test.mockResolvedValueOnce({
      enterprise_id: "E1",
      is_enterprise_install: true,
    });

    const monitor = startSlackMonitor(monitorSlackProvider, {
      appToken: "xapp-1-A1-opaque",
    });
    await expect(stopSlackMonitor(monitor)).resolves.toBeUndefined();
  });

  it("rejects enterprise startup with the default pairing DM policy", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          enterpriseOrgInstall: true,
        },
      },
    });

    const monitor = startSlackMonitor(monitorSlackProvider);
    await expect(monitor.run).rejects.toThrow(
      /supports DMs only with dm\.enabled=false.*dmPolicy="open"/,
    );
  });
});

describe("connected identity health", () => {
  it.each([
    {
      name: "bot identity",
      auth: {
        user_id: "UBOT",
        bot_id: "BBOT",
        team_id: "T1",
        is_enterprise_install: false,
      },
      config: undefined,
      expected: { healthState: "healthy", lastError: null },
    },
    {
      name: "user-token identity",
      auth: {
        user_id: "UUSER",
        team_id: "T1",
        is_enterprise_install: false,
      },
      config: undefined,
      expected: {
        healthState: "degraded",
        lastError: expect.stringContaining("without bot_id"),
      },
    },
    {
      name: "enterprise identity",
      auth: {
        enterprise_id: "E1",
        is_enterprise_install: true,
      },
      config: {
        channels: {
          slack: {
            enterpriseOrgInstall: true,
            dmPolicy: "disabled",
            groupPolicy: "open",
          },
        },
      },
      expected: { healthState: "healthy", lastError: null },
    },
  ])("publishes $name through the provider status callback", async ({ auth, config, expected }) => {
    if (config) {
      resetSlackTestState(config);
    }
    getSlackClient().auth.test.mockResolvedValueOnce(auth);
    const setStatus = vi.fn();

    const monitor = startSlackMonitor(monitorSlackProvider, { setStatus });
    await stopSlackMonitor(monitor);

    expect(setStatus).toHaveBeenCalledWith({
      connected: true,
      lastConnectedAt: expect.any(Number),
      ...expected,
    });
  });

  it("publishes auth.test failures as degraded", async () => {
    getSlackClient().auth.test.mockRejectedValueOnce(new Error("request_timeout"));
    const setStatus = vi.fn();

    const monitor = startSlackMonitor(monitorSlackProvider, { setStatus });
    await stopSlackMonitor(monitor);

    expect(setStatus).toHaveBeenCalledWith({
      connected: true,
      lastConnectedAt: expect.any(Number),
      healthState: "degraded",
      lastError: "request_timeout",
    });
  });
});
