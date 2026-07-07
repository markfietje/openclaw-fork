// Qa Lab Matrix tests cover CLI delegation into the canonical suite host.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runQaSuiteCommand = vi.hoisted(() => vi.fn());

vi.mock("../../cli.runtime.js", () => ({ runQaSuiteCommand }));

import { runQaMatrixCommand } from "./cli.runtime.js";

describe("QA Lab Matrix CLI runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates the release profile into the live Matrix adapter host", async () => {
    await runQaMatrixCommand({
      repoRoot: "/repo",
      outputDir: ".artifacts/matrix",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      fastMode: true,
      profile: "release",
      sutAccountId: "matrix-sut",
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith({
      repoRoot: "/repo",
      outputDir: ".artifacts/matrix",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      fastMode: true,
      allowFailures: undefined,
      channelDriver: "live",
      channel: "matrix",
      concurrency: 1,
      scenarioIds: ["channel-chat-baseline", "matrix-allowlist-hot-reload"],
      sutAccountId: "matrix-sut",
    });
  });

  it("lets explicit scenarios override profile selection", async () => {
    await runQaMatrixCommand({
      profile: "all",
      scenarioIds: ["matrix-restart-resume"],
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioIds: ["matrix-restart-resume"] }),
    );
  });

  it("rejects removed private runner profiles", async () => {
    await expect(runQaMatrixCommand({ profile: "e2ee-deep" })).rejects.toThrow(
      'Unknown QA Lab Matrix profile "e2ee-deep"',
    );
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("rejects unknown provider modes before suite dispatch", async () => {
    await expect(runQaMatrixCommand({ providerMode: "unknown" })).rejects.toThrow(
      "unknown QA provider mode: unknown",
    );
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("rejects shared credential leases", async () => {
    await expect(runQaMatrixCommand({ credentialSource: "convex" })).rejects.toThrow(
      "supports only --credential-source env",
    );
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });
});
