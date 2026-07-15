import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("runSourceCheckoutGlobalInstall", () => {
  let sourceRoot: string;
  let currentPackageRoot: string;
  let pnpmBinDir: string;
  let pnpmGlobalDir: string;
  let pnpmGlobalRoot: string;
  const nodeRunner = "/service/bin/node";

  beforeEach(async () => {
    vi.clearAllMocks();
    sourceRoot = tempDirs.make("openclaw-source-install-");
    const managerRoot = tempDirs.make("openclaw-pnpm-manager-");
    pnpmGlobalDir = path.join(managerRoot, "global");
    pnpmGlobalRoot = path.join(pnpmGlobalDir, "5", "node_modules");
    currentPackageRoot = path.join(pnpmGlobalRoot, "openclaw");
    pnpmBinDir = path.join(managerRoot, "bin");
    await fs.mkdir(currentPackageRoot, { recursive: true });
    await fs.mkdir(pnpmBinDir, { recursive: true });
    await fs.writeFile(
      path.join(currentPackageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", bin: { openclaw: "openclaw.mjs" }, version: "1.0.0" }),
      "utf8",
    );
    await fs.writeFile(path.join(pnpmBinDir, "openclaw"), "old shim\n", "utf8");
    await fs.writeFile(
      path.join(sourceRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        bin: { openclaw: "openclaw.mjs" },
        engines: { node: ">=24.15.0 <25" },
      }),
      "utf8",
    );
    sharedMocks.resolveGlobalManager.mockResolvedValue("pnpm");
    sharedMocks.runCommand.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "pnpm" && argv[1] === "root") {
        return { stdout: `${pnpmGlobalRoot}\n`, stderr: "", code: 0 };
      }
      if (argv[0] === "pnpm" && argv[1] === "bin") {
        return { stdout: `${pnpmBinDir}\n`, stderr: "", code: 0 };
      }
      if (argv[0] === nodeRunner && argv[1] === "--version") {
        return { stdout: "v24.15.0\n", stderr: "", code: 0 };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });
    sharedMocks.runUpdateStep.mockImplementation(async (step) => {
      if (step.name === "global install") {
        await fs.writeFile(
          path.join(currentPackageRoot, "package.json"),
          JSON.stringify({
            name: "openclaw",
            bin: { openclaw: "openclaw.mjs" },
            version: "2.0.0",
          }),
          "utf8",
        );
        await fs.writeFile(path.join(pnpmBinDir, "openclaw"), "new shim\n", "utf8");
      }
      return {
        name: step.name,
        command: step.argv.join(" "),
        cwd: step.cwd,
        durationMs: 1,
        exitCode: 0,
        stdoutTail: "",
        stderrTail: "",
      };
    });
  });

  it("guards pnpm source activation with the managed service Node", async () => {
    const result = await runSourceCheckoutGlobalInstall({
      sourceRoot,
      currentPackageRoot,
      installKind: "package",
      nodeRunner,
      env: { PATH: "/usr/bin", PNPM_HOME: path.dirname(pnpmBinDir) },
      timeoutMs: 20_000,
    });

    expect(sharedMocks.runCommand).toHaveBeenCalledWith(
      [nodeRunner, "--version"],
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(result.steps.map((step) => step.name)).toEqual([
      "global install runtime guard",
      "global install",
      "global install postinstall",
    ]);
    expect(result.failedStep).toBeNull();
    expect(sharedMocks.runUpdateStep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        argv: ["pnpm", "add", "-g", "--global-dir", pnpmGlobalDir, "--ignore-scripts", sourceRoot],
        env: expect.objectContaining({
          PATH: `${path.dirname(nodeRunner)}${path.delimiter}/usr/bin`,
        }),
      }),
    );
    expect(sharedMocks.runUpdateStep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        argv: [nodeRunner, path.join(sourceRoot, "scripts/postinstall-bundled-plugins.mjs")],
        cwd: sourceRoot,
      }),
    );
  });

  it("surfaces a trusted source postinstall failure", async () => {
    sharedMocks.runUpdateStep.mockImplementation(async (step) => {
      if (step.name === "global install") {
        await fs.writeFile(
          path.join(currentPackageRoot, "package.json"),
          JSON.stringify({
            name: "openclaw",
            bin: { openclaw: "openclaw.mjs" },
            version: "2.0.0",
          }),
          "utf8",
        );
        await fs.writeFile(path.join(pnpmBinDir, "openclaw"), "new shim\n", "utf8");
      }
      return {
        name: step.name,
        command: step.argv.join(" "),
        cwd: step.cwd,
        durationMs: 1,
        exitCode: step.name === "global install postinstall" ? 1 : 0,
        stdoutTail: "",
        stderrTail: step.name === "global install postinstall" ? "postinstall failed" : "",
      };
    });

    const result = await runSourceCheckoutGlobalInstall({
      sourceRoot,
      currentPackageRoot,
      installKind: "package",
      nodeRunner,
      env: { PATH: "/usr/bin", PNPM_HOME: path.dirname(pnpmBinDir) },
      timeoutMs: 20_000,
    });

    expect(result.failedStep).toMatchObject({
      name: "global install postinstall",
      stderrTail: "postinstall failed",
    });
    expect(result.steps.at(-1)?.name).toBe("global update rollback");
    await expect(
      fs.readFile(path.join(currentPackageRoot, "package.json"), "utf8"),
    ).resolves.toContain('"version":"1.0.0"');
    await expect(fs.readFile(path.join(pnpmBinDir, "openclaw"), "utf8")).resolves.toBe(
      "old shim\n",
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
      currentPackageRoot,
      installKind: "package",
      nodeRunner,
      env: { PATH: "/usr/bin", PNPM_HOME: path.dirname(pnpmBinDir) },
      timeoutMs: 20_000,
    });

    expect(result.failedStep?.name).toBe("global install runtime guard");
    expect(result.failedStep?.stderrTail).toContain(
      "requires Node >=24.15.0 <25; detected Node 24.14.0",
    );
    expect(sharedMocks.runUpdateStep).not.toHaveBeenCalled();
  });
});
