import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisionMatrixQaRoom } from "./client.js";
import { runMatrixQaDifferentialProbe } from "./differential-probe.js";
import { createMatrixQaSubstrate, runMatrixQaLifecycleScenarios } from "./lifecycle.js";
import {
  createMatrixQaTuwunelSubstrate,
  type MatrixQaTuwunelRuntime,
} from "./tuwunel-lifecycle.runtime.js";

const RUN_REAL_LIFECYCLE = process.env.OPENCLAW_QA_MATRIX_LIFECYCLE_E2E === "1";
const EXPECTED_SCENARIOS = ["cold-start", "idempotent-start", "restart", "stop", "resume"] as const;

describe.runIf(RUN_REAL_LIFECYCLE)("Matrix QA real substrate lifecycle", () => {
  const outputDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      outputDirs.splice(0).map(async (directory) => {
        try {
          await fs.rm(directory, { force: true, recursive: true });
        } catch (error) {
          // Tuwunel writes container-owned database files. The Testbox is disposable,
          // so cleanup must not hide a completed lifecycle proof with an EACCES failure.
          if ((error as NodeJS.ErrnoException).code !== "EACCES") {
            throw error;
          }
        }
      }),
    );
  });

  async function createOutputDir(substrate: string) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `matrix-qa-${substrate}-`));
    outputDirs.push(directory);
    return directory;
  }

  it("passes all five scenarios on Tuwunel", async () => {
    const outputDir = await createOutputDir("tuwunel");
    const substrate = createMatrixQaTuwunelSubstrate({ outputDir });
    let provisioned: Awaited<ReturnType<typeof provisionMatrixQaRoom>> | undefined;

    try {
      const results = await runMatrixQaLifecycleScenarios({
        async probe(runtime: MatrixQaTuwunelRuntime) {
          provisioned ??= await provisionMatrixQaRoom({
            baseUrl: runtime.baseUrl,
            driverLocalpart: "lifecycle-driver",
            observerLocalpart: "lifecycle-observer",
            registrationToken: runtime.harness.registrationToken,
            roomName: "Matrix QA Lifecycle",
            sutLocalpart: "lifecycle-sut",
          });
          await runMatrixQaDifferentialProbe({
            accessToken: provisioned.driver.accessToken,
            baseUrl: runtime.baseUrl,
            roomId: provisioned.roomId,
            userId: provisioned.driver.userId,
          });
        },
        substrate,
      });

      expect(results.map((entry) => entry.id)).toEqual(EXPECTED_SCENARIOS);
    } finally {
      await substrate.stop();
    }
  }, 180_000);

  it("passes all five scenarios on Crabline", async () => {
    const outputDir = await createOutputDir("crabline");
    const { startOpenClawCrablineAdapter } = await import("@openclaw/crabline");
    const roomId = "!matrix-qa-lifecycle:matrix.test";
    const substrate = createMatrixQaSubstrate({
      id: "crabline",
      async start() {
        const adapter = await startOpenClawCrablineAdapter({
          channel: "matrix",
          recorderPath: path.join(outputDir, "crabline-matrix.jsonl"),
        });
        if (adapter.manifest.provider !== "matrix") {
          await adapter.close();
          throw new Error("Crabline Matrix adapter returned a non-Matrix manifest");
        }
        const manifest = adapter.manifest;
        try {
          await adapter.probe();
          const inbound = adapter.createInbound({
            input: {
              conversation: { id: roomId, kind: "group" },
              senderId: "@lifecycle-driver:matrix.test",
              text: "Matrix lifecycle probe",
            },
          });
          const response = await fetch(inbound.providerUrl, {
            body: JSON.stringify(inbound.providerBody),
            headers: inbound.providerHeaders,
            method: "POST",
          });
          await response.body?.cancel();
          if (!response.ok) {
            throw new Error(`Crabline Matrix inbound setup returned HTTP ${response.status}`);
          }
          return {
            accessToken: manifest.accessToken,
            adapter,
            baseUrl: manifest.baseUrl,
            roomId,
            userId: manifest.botUserId,
          };
        } catch (error) {
          await adapter.close().catch(() => {});
          throw error;
        }
      },
      async stop(runtime) {
        await runtime.adapter.close();
      },
    });

    try {
      const results = await runMatrixQaLifecycleScenarios({
        async probe(runtime) {
          await runMatrixQaDifferentialProbe({
            accessToken: runtime.accessToken,
            baseUrl: runtime.baseUrl,
            roomId: runtime.roomId,
            userId: runtime.userId,
          });
        },
        substrate,
      });

      expect(results.map((entry) => entry.id)).toEqual(EXPECTED_SCENARIOS);
    } finally {
      await substrate.stop();
    }
  }, 30_000);
});
