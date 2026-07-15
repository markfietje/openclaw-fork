import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { prepareRegistryPackageInstallSpec } from "./package-update-source.js";
import type { PackageUpdateStepResult } from "./package-update-types.js";

describe("registry package update resolution", () => {
  it("pins the version selected by the package manager in an isolated global directory", async () => {
    let resolutionGlobalDir: string | null = null;
    let resolutionBinDir: string | null = null;
    const runStep = vi.fn(async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
      expect(name).toBe("global update registry resolve");
      expect(argv.at(-1)).toBe("openclaw@^2");
      const globalDirIndex = argv.indexOf("--global-dir");
      const globalDir = argv[globalDirIndex + 1];
      const globalBinDirIndex = argv.indexOf("--global-bin-dir");
      const globalBinDir = argv[globalBinDirIndex + 1];
      if (!globalDir || !globalBinDir) {
        throw new Error("missing isolated global directories");
      }
      resolutionGlobalDir = globalDir;
      resolutionBinDir = globalBinDir;
      const pathValue = Object.entries(env ?? {}).find(
        ([key]) => key.toUpperCase() === "PATH",
      )?.[1];
      expect(pathValue?.split(path.delimiter)).toContain(globalBinDir);
      const packageRoot = path.join(globalDir, "v11", "install", "node_modules", "openclaw");
      await fs.mkdir(packageRoot, { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2.0.0",
          engines: { node: ">=24.15.0 <25" },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(packageRoot, "registry-marker.txt"), "pnpm artifact\n", "utf8");
      await fs.mkdir(path.join(packageRoot, "node_modules", "dependency"), { recursive: true });
      return {
        name,
        command: argv.join(" "),
        cwd: cwd ?? process.cwd(),
        durationMs: 1,
        exitCode: 0,
      };
    });

    const result = await prepareRegistryPackageInstallSpec({
      installTarget: {
        manager: "pnpm",
        command: "pnpm",
        globalRoot: "/tmp/pnpm/v11",
        packageRoot: "/tmp/pnpm/v11/install/node_modules/openclaw",
      },
      installSpec: "openclaw@^2",
      packageName: "openclaw",
      runStep,
      timeoutMs: 1000,
      runtimeVersion: "24.15.0",
    });

    expect(result.failedStep).toBeNull();
    expect(result.installSpec).toBe("openclaw@2.0.0");
    expect(result.steps.map((step) => step.name)).toEqual([
      "global update registry resolve",
      "global update registry version guard",
      "global update registry runtime guard",
      "global update registry artifact",
    ]);
    expect(runStep).toHaveBeenCalledOnce();
    expect(resolutionGlobalDir).not.toBeNull();
    expect(resolutionBinDir).not.toBeNull();
    await expect(fs.access(resolutionGlobalDir!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(resolutionBinDir!)).rejects.toMatchObject({ code: "ENOENT" });
    if (!result.packedArtifact) {
      throw new Error("expected manager-selected package artifact");
    }
    const entries: string[] = [];
    await tar.t({
      file: result.packedArtifact.tarballPath,
      onentry: (entry) => {
        entries.push(entry.path);
        entry.resume();
      },
    });
    expect(entries).toContain("package/registry-marker.txt");
    expect(entries.some((entry) => entry.startsWith("package/node_modules/"))).toBe(false);
    await fs.rm(result.packedArtifact.cleanupDir, { recursive: true, force: true });
  });

  it("isolates Bun's global package and executable directories", async () => {
    let resolutionGlobalDir: string | null = null;
    let resolutionBinDir: string | null = null;
    const runStep = vi.fn(async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
      expect(name).toBe("global update registry resolve");
      expect(argv).toEqual(["bun", "add", "-g", "--ignore-scripts", "openclaw@latest"]);
      resolutionGlobalDir = env?.BUN_INSTALL_GLOBAL_DIR ?? null;
      resolutionBinDir = env?.BUN_INSTALL_BIN ?? null;
      if (!resolutionGlobalDir || !resolutionBinDir) {
        throw new Error("missing isolated Bun directories");
      }
      expect(path.dirname(resolutionGlobalDir)).toBe(path.dirname(resolutionBinDir));
      const packageRoot = path.join(resolutionGlobalDir, "node_modules", "openclaw");
      await fs.mkdir(packageRoot, { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.7.2",
          engines: { node: ">=24.15.0 <25" },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(packageRoot, "registry-marker.txt"), "bun artifact\n", "utf8");
      return {
        name,
        command: argv.join(" "),
        cwd: cwd ?? process.cwd(),
        durationMs: 1,
        exitCode: 0,
      };
    });

    const result = await prepareRegistryPackageInstallSpec({
      installTarget: {
        manager: "bun",
        command: "bun",
        globalRoot: "/tmp/bun/install/global/node_modules",
        packageRoot: "/tmp/bun/install/global/node_modules/openclaw",
      },
      installSpec: "openclaw@latest",
      packageName: "openclaw",
      runStep,
      timeoutMs: 1000,
      runtimeVersion: "24.15.0",
    });

    expect(result.failedStep).toBeNull();
    expect(result.installSpec).toBe("openclaw@2026.7.2");
    expect(result.steps.map((step) => step.name)).toEqual([
      "global update registry resolve",
      "global update registry version guard",
      "global update registry runtime guard",
      "global update registry artifact",
    ]);
    expect(resolutionGlobalDir).not.toBeNull();
    expect(resolutionBinDir).not.toBeNull();
    await expect(fs.access(resolutionGlobalDir!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(resolutionBinDir!)).rejects.toMatchObject({ code: "ENOENT" });
    if (!result.packedArtifact) {
      throw new Error("expected manager-selected package artifact");
    }
    const extractDir = path.join(result.packedArtifact.cleanupDir, "extract");
    await fs.mkdir(extractDir);
    await tar.x({ file: result.packedArtifact.tarballPath, cwd: extractDir });
    await expect(
      fs.readFile(path.join(extractDir, "package", "registry-marker.txt"), "utf8"),
    ).resolves.toBe("bun artifact\n");
    await fs.rm(result.packedArtifact.cleanupDir, { recursive: true, force: true });
  });
});
