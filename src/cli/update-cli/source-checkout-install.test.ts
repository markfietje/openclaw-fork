import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
  resolveGlobalManager: vi.fn(),
  runUpdateStep: vi.fn(),
}));

vi.mock("./shared.js", () => ({
  createGlobalCommandRunner: () => sharedMocks.runCommand,
  resolveGlobalManager: (...args: unknown[]) => sharedMocks.resolveGlobalManager(...args),
  runUpdateStep: (...args: unknown[]) => sharedMocks.runUpdateStep(...args),
}));

const { runSourceCheckoutGlobalInstall } = await import("./source-checkout-install.js");

describe("runSourceCheckoutGlobalInstall", () => {
  let sourceRoot: string;
  const nodeRunner = "/service/bin/node";
  const pnpmGlobalRoot = "/tmp/openclaw-pnpm-global/5/node_modules";

  beforeEach(async () => {
    vi.clearAllMocks();
    sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-source-install-"));
    await fs.writeFile(
      path.join(sourceRoot, "package.json"),
      JSON.stringify({ name: "openclaw", engines: { node: ">=24.15.0 <25" } }),
      "utf8",
    );
    sharedMocks.resolveGlobalManager.mockResolvedValue("pnpm");
    sharedMocks.runCommand.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "pnpm" && argv[1] === "root") {
        return { stdout: `${pnpmGlobalRoot}\n`, stderr: "", code: 0 };
      }
      if (argv[0] === nodeRunner && argv[1] === "--version") {
        return { stdout: "v24.15.0\n", stderr: "", code: 0 };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });
    sharedMocks.runUpdateStep.mockImplementation(async (step) => ({
      name: step.name,
      command: step.argv.join(" "),
      cwd: step.cwd,
      durationMs: 1,
      exitCode: 0,
      stdoutTail: "",
      stderrTail: "",
    }));
  });

  afterEach(async () => {
    await fs.rm(sourceRoot, { recursive: true, force: true });
  });

  it("guards pnpm source activation with the managed service Node", async () => {
    const result = await runSourceCheckoutGlobalInstall({
      sourceRoot,
      currentPackageRoot: path.join(pnpmGlobalRoot, "openclaw"),
      installKind: "package",
      nodeRunner,
      env: { PATH: "/usr/bin" },
      timeoutMs: 20_000,
    });

    expect(sharedMocks.runCommand).toHaveBeenCalledWith(
      [nodeRunner, "--version"],
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(result.steps.map((step) => step.name)).toEqual([
      "global install runtime guard",
      "global install",
    ]);
    expect(result.failedStep).toBeNull();
    expect(sharedMocks.runUpdateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["pnpm", "add", "-g", "--global-dir", "/tmp/openclaw-pnpm-global", sourceRoot],
        env: expect.objectContaining({
          PATH: `${path.dirname(nodeRunner)}${path.delimiter}/usr/bin`,
        }),
      }),
    );
  });

  it("blocks pnpm source activation when the managed service Node is incompatible", async () => {
    sharedMocks.runCommand.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "pnpm" && argv[1] === "root") {
        return { stdout: `${pnpmGlobalRoot}\n`, stderr: "", code: 0 };
      }
      if (argv[0] === nodeRunner && argv[1] === "--version") {
        return { stdout: "v24.14.0\n", stderr: "", code: 0 };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const result = await runSourceCheckoutGlobalInstall({
      sourceRoot,
      currentPackageRoot: path.join(pnpmGlobalRoot, "openclaw"),
      installKind: "package",
      nodeRunner,
      env: { PATH: "/usr/bin" },
      timeoutMs: 20_000,
    });

    expect(result.failedStep?.name).toBe("global install runtime guard");
    expect(result.failedStep?.stderrTail).toContain(
      "requires Node >=24.15.0 <25; detected Node 24.14.0",
    );
    expect(sharedMocks.runUpdateStep).not.toHaveBeenCalled();
  });
});
