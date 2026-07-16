// Slack tests cover probe plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeSlack } from "./probe.js";

const authTestMock = vi.hoisted(() => vi.fn());
const createSlackWebClientMock = vi.hoisted(() => vi.fn());
const withTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createSlackWebClient: createSlackWebClientMock,
}));

vi.mock("openclaw/plugin-sdk/text-utility-runtime", () => ({
  withTimeout: withTimeoutMock,
}));

function requireFirstTimeoutCall() {
  const [call] = withTimeoutMock.mock.calls;
  if (!call) {
    throw new Error("expected withTimeout call");
  }
  return call;
}

describe("probeSlack", () => {
  beforeEach(() => {
    authTestMock.mockReset();
    createSlackWebClientMock.mockReset();
    withTimeoutMock.mockReset();

    createSlackWebClientMock.mockReturnValue({
      auth: {
        test: authTestMock,
      },
    });
    withTimeoutMock.mockImplementation(async (promise: Promise<unknown>) => await promise);
  });

  it("maps Slack auth metadata on success", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "U123",
      bot_id: "B123",
      user: "openclaw-bot",
      team_id: "T123",
      team: "OpenClaw",
    });

    await expect(probeSlack("xoxb-test", 2500)).resolves.toEqual({
      ok: true,
      status: 200,
      elapsedMs: 45,
      bot: { id: "U123", name: "openclaw-bot" },
      team: { id: "T123", name: "OpenClaw" },
    });
    expect(createSlackWebClientMock).toHaveBeenCalledWith("xoxb-test");
    expect(withTimeoutMock).toHaveBeenCalledTimes(1);
    const [promise, timeoutMs] = requireFirstTimeoutCall();
    expect(promise).toBeInstanceOf(Promise);
    expect(timeoutMs).toBe(2500);
  });

  it("warns when auth.test looks like a user token in the bot token slot", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "UUSER",
      user: "human-installer",
      team_id: "T123",
      team: "OpenClaw",
    });

    await expect(probeSlack("xoxp-user-token", 2500, { accountId: "work" })).resolves.toMatchObject(
      {
        ok: true,
        warning:
          'Slack auth.test identified account "work" as user UUSER without bot_id. channels.slack.accounts.work.botToken appears to contain a user token; replace it with a Bot User OAuth Token. Until replaced, explicit bot-mention detection is disabled and required-mention channels fail closed.',
      },
    );
  });

  it("accepts a user-token auth identity when user identity mode is explicit", async () => {
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "UUSER",
      user: "agent-user",
      team_id: "T123",
      team: "Workspace",
    });

    const result = await probeSlack("xoxp-user-token", 2500, {
      accountId: "work",
      identityMode: "user",
    });

    expect(result).toMatchObject({
      ok: true,
      bot: { id: "UUSER", name: "agent-user" },
      team: { id: "T123", name: "Workspace" },
    });
    expect(result.warning).toBeUndefined();
  });

  it("rejects a bot-token auth identity when user identity mode is explicit", async () => {
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "UBOT",
      bot_id: "BBOT",
      team_id: "T123",
    });

    await expect(
      probeSlack("xoxb-test", 2500, { accountId: "work", identityMode: "user" }),
    ).resolves.toMatchObject({
      ok: false,
      status: 200,
      error: "auth.test returned bot_id for a user identity token",
    });
  });

  it("rejects a user identity without auth.test user_id", async () => {
    authTestMock.mockResolvedValue({ ok: true, team_id: "T123" });

    await expect(
      probeSlack("xoxp-test", 2500, { accountId: "work", identityMode: "user" }),
    ).resolves.toMatchObject({
      ok: false,
      status: 200,
      error: "auth.test returned no user_id",
    });
  });

  it("keeps optional auth metadata fields undefined when Slack omits them", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(200).mockReturnValueOnce(235);
    authTestMock.mockResolvedValue({ ok: true });

    const result = await probeSlack("xoxb-test");

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.elapsedMs).toBe(35);
    expect(result.bot).toStrictEqual({ id: undefined, name: undefined });
    expect(result.team).toStrictEqual({ id: undefined, name: undefined });
  });
});
