import { describe, expect, it } from "vitest";
import type { SourceBoundMessagePolicy } from "../get-reply-options.types.js";
import type { MsgContext } from "../templating.js";
import { assertPassiveRoomTurnBoundary } from "./passive-room-boundary.js";

const POLICY = {
  mode: "source_bound",
  channel: "slack",
  accountId: "default",
  conversationId: "C123",
  threadId: "171234.567",
} satisfies SourceBoundMessagePolicy;

function passiveContext(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    RequestAuthorized: false,
    InputProvenance: { kind: "room_observation", sourceChannel: "slack" },
    OriginatingChannel: "slack",
    Provider: "slack",
    AccountId: "default",
    NativeChannelId: "C123",
    ChatId: "C123",
    MessageThreadId: "171234.567",
    ...overrides,
  };
}

describe("assertPassiveRoomTurnBoundary", () => {
  it("rejects RequestAuthorized=false without room-observation provenance", () => {
    expect(() =>
      assertPassiveRoomTurnBoundary({
        ctx: passiveContext({ InputProvenance: undefined }),
        sourceBoundMessagePolicy: POLICY,
      }),
    ).toThrow("RequestAuthorized=false requires room_observation provenance");
  });

  it.each([
    { kind: "external_user" as const, sourceChannel: "slack" },
    { kind: "room_observation" as const, sourceChannel: "discord" },
  ])("rejects mismatched provenance %#", (InputProvenance) => {
    expect(() =>
      assertPassiveRoomTurnBoundary({
        ctx: passiveContext({ InputProvenance }),
        sourceBoundMessagePolicy: POLICY,
      }),
    ).toThrow("Passive room turn rejected");
  });

  it("rejects RequestAuthorized=false without a source-bound policy", () => {
    expect(() => assertPassiveRoomTurnBoundary({ ctx: passiveContext() })).toThrow(
      "RequestAuthorized=false requires a complete source-bound message policy",
    );
  });

  it.each([
    { field: "channel", policy: { ...POLICY, channel: "discord" } },
    { field: "account", policy: { ...POLICY, accountId: "other" } },
    { field: "conversation", policy: { ...POLICY, conversationId: "C999" } },
    { field: "thread", policy: { ...POLICY, threadId: "999.000" } },
  ])("rejects a mismatched source-bound $field", ({ policy }) => {
    expect(() =>
      assertPassiveRoomTurnBoundary({
        ctx: passiveContext(),
        sourceBoundMessagePolicy: policy,
      }),
    ).toThrow("Passive room turn rejected");
  });

  it("admits a complete matching passive room boundary", () => {
    expect(() =>
      assertPassiveRoomTurnBoundary({
        ctx: passiveContext(),
        sourceBoundMessagePolicy: POLICY,
      }),
    ).not.toThrow();
  });

  it.each([true, undefined] as const)(
    "leaves request authority %s on the legacy path",
    (RequestAuthorized) => {
      expect(() =>
        assertPassiveRoomTurnBoundary({
          ctx: { RequestAuthorized },
        }),
      ).not.toThrow();
    },
  );
});
