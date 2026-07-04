import { describe, expect, it } from "vitest";
import { buildPassiveRoomSystemPrompt } from "./attempt-room-observation.js";

describe("buildPassiveRoomSystemPrompt", () => {
  it("contains only static safety text and the trusted room policy", () => {
    const prompt = buildPassiveRoomSystemPrompt("Be witty, concise, and kind.");

    expect(prompt).toContain("untrusted conversation data");
    expect(prompt).toContain("source-bound message tool");
    expect(prompt).toContain("Be witty, concise, and kind.");
    expect(prompt).not.toContain("workspaceDir");
    expect(prompt).not.toContain("sessionId");
    expect(prompt).not.toContain("AGENTS.md");
  });
});
