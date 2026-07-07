// Qa Lab Matrix tests cover the thin CLI selector and adapter registration.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const runQaMatrixCommand = vi.hoisted(() => vi.fn());

vi.mock("./cli.runtime.js", () => ({ runQaMatrixCommand }));

import { matrixQaAdapterFactory, matrixQaCliRegistration } from "./cli.js";

describe("QA Lab Matrix CLI registration", () => {
  it("keeps the canonical Matrix release scenarios on the live adapter", () => {
    expect(matrixQaAdapterFactory.scenarioIds).toEqual([
      "channel-chat-baseline",
      "matrix-allowlist-hot-reload",
    ]);
  });

  it("exposes only canonical QA Lab selector flags", () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    const matrix = qa.commands.find((command) => command.name() === "matrix");
    const optionNames = matrix?.options.map((option) => option.long) ?? [];

    for (const optionName of [
      "--repo-root",
      "--output-dir",
      "--provider-mode",
      "--model",
      "--alt-model",
      "--scenario",
      "--fast",
      "--profile",
      "--sut-account",
    ]) {
      expect(optionNames).toContain(optionName);
    }
    expect(optionNames).not.toContain("--fail-fast");
    expect(optionNames).not.toContain("--credential-source");
    expect(optionNames).not.toContain("--credential-role");
  });

  it("delegates command options without custom process handling", async () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);

    await qa.parseAsync([
      "node",
      "openclaw",
      "matrix",
      "--profile",
      "release",
      "--scenario",
      "matrix-allowlist-hot-reload",
    ]);

    expect(runQaMatrixCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "release",
        scenarioIds: ["matrix-allowlist-hot-reload"],
      }),
    );
  });
});
