import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  prepareLivePackageRollback,
  restoreLivePackageRollback,
} from "./package-update-live-activation.js";

describe("live package activation rollback", () => {
  it.skipIf(process.platform === "win32")(
    "restores manager state and external bin symlinks without retaining new shims",
    async () => {
      await withTempDir({ prefix: "openclaw-live-activation-" }, async (base) => {
        const stateRoot = path.join(base, "global");
        const globalRoot = path.join(stateRoot, "11", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const cliPath = path.join(packageRoot, "openclaw.mjs");
        const binDir = path.join(base, "bin");
        const binPath = path.join(binDir, "openclaw");
        const oldLinkTarget = path.relative(binDir, cliPath);
        await fs.mkdir(packageRoot, { recursive: true });
        await fs.mkdir(binDir, { recursive: true });
        await fs.writeFile(cliPath, "old cli\n", "utf8");
        await fs.symlink(oldLinkTarget, binPath, "file");

        const prepared = await prepareLivePackageRollback({
          installTarget: {
            manager: "pnpm",
            command: "pnpm",
            globalRoot,
            packageRoot,
          },
          binNames: ["openclaw"],
          runCommand: async (argv) => {
            expect(argv).toEqual(["pnpm", "bin", "-g"]);
            return { stdout: `${binDir}\n`, stderr: "", code: 0 };
          },
          timeoutMs: 20_000,
        });
        expect(prepared.failedStep).toBeNull();

        await fs.rm(stateRoot, { recursive: true, force: true });
        await fs.mkdir(packageRoot, { recursive: true });
        await fs.writeFile(cliPath, "candidate cli\n", "utf8");
        await fs.rm(binPath, { force: true });
        await fs.writeFile(binPath, "candidate shim\n", "utf8");
        await fs.writeFile(`${binPath}.cmd`, "candidate cmd shim\n", "utf8");

        const restored = await restoreLivePackageRollback(prepared.rollback);

        expect(restored?.exitCode).toBe(0);
        await expect(fs.readFile(cliPath, "utf8")).resolves.toBe("old cli\n");
        await expect(fs.readlink(binPath)).resolves.toBe(oldLinkTarget);
        await expect(fs.access(`${binPath}.cmd`)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});
