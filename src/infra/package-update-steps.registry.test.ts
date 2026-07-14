import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  expectPathMissing,
  type PackageUpdateStepResult,
  writePackageRoot,
} from "../../test/helpers/package-update-steps.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "./package-dist-inventory.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import type { CommandRunner } from "./update-global.js";

function isolatedPnpmGlobalDir(argv: string[]): string {
  const index = argv.indexOf("--global-dir");
  const globalDir = argv[index + 1];
  if (!globalDir) {
    throw new Error("missing isolated pnpm global directory");
  }
  return globalDir;
}

describe("registry package update steps", () => {
  it("rejects an incompatible pnpm registry target before the live install", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-registry-guard-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm", "v11");
      const packageRoot = path.join(globalRoot, "install", "node_modules", "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update registry resolve") {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv.at(-1)).toBe("openclaw@latest");
        const candidateRoot = path.join(
          isolatedPnpmGlobalDir(argv),
          "v11",
          "install",
          "node_modules",
          "openclaw",
        );
        await writePackageRoot(candidateRoot, "2.0.0", { nodeEngine: ">=24.15.0 <25" });
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });
      const runCommand = vi.fn<CommandRunner>(async (argv) => {
        if (argv.join(" ") === "/service/node --version") {
          return { stdout: "v24.14.0\n", stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@latest",
        packageName: "openclaw",
        packageRoot,
        nodePath: "/service/node",
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toMatchObject({
        name: "global update registry runtime guard",
        stderrTail: expect.stringContaining("detected Node 24.14.0"),
      });
      expect(result.afterVersion).toBe("1.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update registry resolve",
        "global update registry version guard",
        "global update registry runtime guard",
      ]);
      expect(runStep).toHaveBeenCalledOnce();
    });
  });

  it("uses pnpm 10 itself to resolve a range without requiring npm", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm10-resolve-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm", "5", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update registry resolve") {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv[0]).toBe("pnpm");
        expect(argv).toContain("--ignore-scripts");
        expect(argv.at(-1)).toBe("openclaw@^2");
        const candidateRoot = path.join(
          isolatedPnpmGlobalDir(argv),
          "5",
          "node_modules",
          "openclaw",
        );
        await writePackageRoot(candidateRoot, "2.1.0", { nodeEngine: ">=999.0.0" });
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });
      const runCommand = vi.fn<CommandRunner>(async (argv) => {
        if (argv.join(" ") === "/service/node --version") {
          return { stdout: "v24.15.0\n", stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@^2",
        packageName: "openclaw",
        packageRoot,
        nodePath: "/service/node",
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toMatchObject({
        name: "global update registry runtime guard",
        stderrTail: expect.stringContaining("requires Node >=999.0.0"),
      });
      expect(result.afterVersion).toBe("1.0.0");
      expect(runStep).toHaveBeenCalledOnce();
      expect(runCommand).toHaveBeenCalledOnce();
    });
  });

  it("pins Bun's isolated resolution and runs only OpenClaw's validated lifecycle", async () => {
    await withTempDir({ prefix: "openclaw-package-update-bun-registry-" }, async (base) => {
      const globalRoot = path.join(base, "bun", "install", "global", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const runStep = vi.fn(async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
        if (name === "global update registry resolve") {
          expect(argv).toEqual(["bun", "add", "-g", "--ignore-scripts", "openclaw@latest"]);
          const candidateGlobalDir = env?.BUN_INSTALL_GLOBAL_DIR;
          expect(candidateGlobalDir).not.toBe(path.dirname(globalRoot));
          if (!candidateGlobalDir) {
            throw new Error("missing isolated Bun global directory");
          }
          await writePackageRoot(
            path.join(candidateGlobalDir, "node_modules", "openclaw"),
            "2.0.0",
            {
              nodeEngine: ">=24.15.0 <25",
            },
          );
        } else if (name === "global update") {
          expect(env?.BUN_INSTALL_GLOBAL_DIR).toBe(path.dirname(globalRoot));
          expect(argv).toEqual(["bun", "add", "-g", "--ignore-scripts", "openclaw@2.0.0"]);
          await writePackageRoot(packageRoot, "2.0.0", {
            installGuard: true,
            nodeEngine: ">=24.15.0 <25",
          });
        } else if (name === "global install postinstall") {
          expect(cwd).toBe(packageRoot);
          expect(argv[1]).toBe(
            path.join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
          );
        } else {
          throw new Error(`unexpected step ${name}`);
        }
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });
      const runCommand = vi.fn<CommandRunner>(async (argv) => {
        if (argv.join(" ") === "/service/node --version") {
          return { stdout: "v24.15.0\n", stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "bun",
          command: "bun",
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@latest",
        packageName: "openclaw",
        packageRoot,
        nodePath: "/service/node",
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update registry resolve",
        "global update registry version guard",
        "global update registry runtime guard",
        "global update",
        "global install runtime guard",
        "global install postinstall",
      ]);
      await expectPathMissing(path.join(packageRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH));
    });
  });
});
