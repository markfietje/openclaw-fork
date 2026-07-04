// Filesystem coverage for trajectory suppression on passive room attempts.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const sessionKey = "agent:main:slack:channel:trajectory-privacy";
const passiveAttemptOverrides = {
  inputProvenance: { kind: "room_observation" as const, sourceChannel: "slack" },
  passiveRoomObservationAdmission: "core-openai" as const,
  disableTrajectories: true,
};

async function expectMissing(filePath: string): Promise<void> {
  await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("runEmbeddedAttempt trajectory suppression", () => {
  const tempPaths: string[] = [];

  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    vi.stubEnv("OPENCLAW_TRAJECTORY", "1");
    vi.stubEnv("OPENCLAW_TRAJECTORY_DIR", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanupTempPaths(tempPaths);
    vi.restoreAllMocks();
  });

  it("creates no default trajectory artifacts for passive room observations", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: passiveAttemptOverrides,
    });

    const workspaceDir = tempPaths[0] ?? "";
    await expectMissing(path.join(workspaceDir, "session.trajectory.jsonl"));
    await expectMissing(path.join(workspaceDir, "session.trajectory-path.json"));
  });

  it("creates no optional diagnostic artifacts for passive room observations", async () => {
    const diagnosticsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-passive-diagnostics-"),
    );
    tempPaths.push(diagnosticsDir);
    const cacheTracePath = path.join(diagnosticsDir, "cache-trace.jsonl");
    const anthropicPayloadPath = path.join(diagnosticsDir, "anthropic-payload.jsonl");
    vi.stubEnv("OPENCLAW_CACHE_TRACE", "1");
    vi.stubEnv("OPENCLAW_CACHE_TRACE_FILE", cacheTracePath);
    vi.stubEnv("OPENCLAW_ANTHROPIC_PAYLOAD_LOG", "1");
    vi.stubEnv("OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE", anthropicPayloadPath);

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: passiveAttemptOverrides,
    });

    await expectMissing(cacheTracePath);
    await expectMissing(anthropicPayloadPath);
  });

  it("does not create or append configured-directory trajectories for passive observations", async () => {
    const trajectoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-passive-trajectory-"));
    tempPaths.push(trajectoryDir);
    vi.stubEnv("OPENCLAW_TRAJECTORY_DIR", trajectoryDir);

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: passiveAttemptOverrides,
    });

    expect(await fs.readdir(trajectoryDir)).toEqual([]);
    const configuredTrajectoryPath = path.join(trajectoryDir, "embedded-session.jsonl");
    const sentinel = '{"sentinel":true}\n';
    await fs.writeFile(configuredTrajectoryPath, sentinel, "utf8");

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: passiveAttemptOverrides,
    });

    expect(await fs.readFile(configuredTrajectoryPath, "utf8")).toBe(sentinel);
    for (const attemptDir of tempPaths.filter((entry) => entry !== trajectoryDir)) {
      await expectMissing(path.join(attemptDir, "session.trajectory-path.json"));
    }
  });

  it("keeps default trajectories enabled for normal authorized attempts", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
    });

    const workspaceDir = tempPaths[0] ?? "";
    const trajectory = await fs.readFile(
      path.join(workspaceDir, "session.trajectory.jsonl"),
      "utf8",
    );
    expect(trajectory).toContain('"type":"session.started"');
    await expect(
      fs.stat(path.join(workspaceDir, "session.trajectory-path.json")),
    ).resolves.toBeDefined();
  });
});
