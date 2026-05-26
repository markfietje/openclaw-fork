import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentHarnesses,
  registerAgentHarness,
  restoreRegisteredAgentHarnesses,
  listRegisteredAgentHarnesses,
} from "./registry.js";
import { prewarmAgentHarnessRuntime } from "./prewarm.js";
import type { AgentHarness } from "./types.js";

describe("prewarmAgentHarnessRuntime", () => {
  let previousHarnesses: ReturnType<typeof listRegisteredAgentHarnesses>;

  beforeEach(() => {
    previousHarnesses = listRegisteredAgentHarnesses();
    clearAgentHarnesses();
  });

  afterEach(() => {
    restoreRegisteredAgentHarnesses(previousHarnesses);
  });

  it("prewarms a selected plugin harness without starting a turn", async () => {
    const prewarm = vi.fn<NonNullable<AgentHarness["prewarm"]>>();
    registerAgentHarness({
      id: "test-harness",
      label: "Test harness",
      supports: () => ({ supported: true, priority: 1 }),
      prewarm,
      runAttempt: vi.fn(),
    });

    await expect(
      prewarmAgentHarnessRuntime({
        provider: "test",
        modelId: "model-a",
        sessionKey: "agent:main:main",
        reason: "tui-startup",
      }),
    ).resolves.toEqual({ status: "warmed", harnessId: "test-harness" });
    expect(prewarm).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "test",
        modelId: "model-a",
        sessionKey: "agent:main:main",
        reason: "tui-startup",
      }),
    );
  });

});
