// Shared fixtures for package update step tests.
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { expect } from "vitest";
import {
  PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  writePackageDistInventory,
} from "../../scripts/lib/package-dist-inventory.ts";
import type { runGlobalPackageUpdateSteps } from "../../src/infra/package-update-steps.js";
import type { CommandRunner, ResolvedGlobalInstallTarget } from "../../src/infra/update-global.js";

export type PackageUpdateStepResult = Awaited<
  ReturnType<typeof runGlobalPackageUpdateSteps>
>["steps"][number];
export const TEST_GIT_COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const TEST_GIT_SHA256_COMMIT = `${TEST_GIT_COMMIT}0123456789abcdef01234567`;

export function successfulPackagePostinstallStep(params: {
  name: string;
  argv: string[];
  cwd?: string;
}): PackageUpdateStepResult | null {
  if (params.name !== "global install postinstall") {
    return null;
  }
  return {
    name: params.name,
    command: params.argv.join(" "),
    cwd: params.cwd ?? process.cwd(),
    durationMs: 1,
    exitCode: 0,
  };
}

export function successfulSourceMetadataStep(params: {
  name: string;
  argv: string[];
  cwd?: string;
  nodeEngine?: string;
  resolved: string;
  arrayOutput?: boolean;
}): PackageUpdateStepResult | null {
  if (params.name !== "global update source metadata") {
    return null;
  }
  const metadata = {
    "engines.node": params.nodeEngine ?? ">=0.0.0",
    _resolved: params.resolved,
  };
  return {
    name: params.name,
    command: params.argv.join(" "),
    cwd: params.cwd ?? process.cwd(),
    durationMs: 1,
    exitCode: 0,
    stdoutTail: JSON.stringify(params.arrayOutput === false ? metadata : [metadata]),
  };
}

export async function writePackageRoot(
  packageRoot: string,
  version: string,
  options: { installGuard?: boolean; nodeEngine?: string; packageName?: string } = {},
): Promise<void> {
  await Promise.all([
    fs.mkdir(path.join(packageRoot, "dist"), { recursive: true }),
    fs.mkdir(path.join(packageRoot, "scripts"), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: options.packageName ?? "openclaw",
        bin: { openclaw: "openclaw.mjs" },
        version,
        engines: { node: options.nodeEngine ?? ">=0.0.0" },
        scripts: {
          preinstall: "node scripts/preinstall-package-manager-warning.mjs",
          postinstall: "node scripts/postinstall-bundled-plugins.mjs",
        },
      }),
      "utf8",
    ),
    fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8"),
    fs.writeFile(
      path.join(packageRoot, "scripts", "preinstall-package-manager-warning.mjs"),
      "// test preinstall\n",
      "utf8",
    ),
    fs.writeFile(
      path.join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
      "// test postinstall\n",
      "utf8",
    ),
  ]);
  await writePackageDistInventory(packageRoot);
  if (
    options.installGuard === true ||
    packageRoot.split(path.sep).some((part) => part.startsWith(".openclaw-update-stage-"))
  ) {
    await fs.writeFile(
      path.join(packageRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH),
      "preinstall incomplete\n",
      "utf8",
    );
  }
}

export async function writeInstalledPackageRoot(
  packageRoot: string,
  version: string,
  options: { nodeEngine?: string; packageName?: string } = {},
): Promise<void> {
  await writePackageRoot(packageRoot, version, options);
  await fs.rm(path.join(packageRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH), { force: true });
}

export async function writePackageTarball(
  packDir: string,
  version: string,
  options: { nodeEngine?: string; packageName?: string } = {},
): Promise<string> {
  const packedRoot = path.join(packDir, "package");
  await writePackageRoot(packedRoot, version, {
    installGuard: true,
    ...(options.nodeEngine === undefined ? {} : { nodeEngine: options.nodeEngine }),
    ...(options.packageName === undefined ? {} : { packageName: options.packageName }),
  });
  const tarballPath = path.join(packDir, `openclaw-${version}.tgz`);
  await tar.c({ cwd: packDir, file: tarballPath, gzip: true }, ["package"]);
  return tarballPath;
}

export async function addHardlinkedPackageFile(
  packageRoot: string,
  linkRoot: string,
): Promise<void> {
  const packageFile = path.join(packageRoot, "dist", "index.js");
  await fs.mkdir(linkRoot, { recursive: true });
  await fs.link(packageFile, path.join(linkRoot, `${path.basename(packageRoot)}-index.js`));
}

export function createNpmTarget(globalRoot: string): ResolvedGlobalInstallTarget {
  return {
    manager: "npm",
    command: "npm",
    globalRoot,
    packageRoot: path.join(globalRoot, "openclaw"),
  };
}

export function createFsError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

export function createPnpmTarget(globalRoot: string): ResolvedGlobalInstallTarget {
  return {
    manager: "pnpm",
    command: "pnpm",
    globalRoot,
    packageRoot: path.join(globalRoot, "openclaw"),
  };
}

export async function expectPathMissing(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${filePath}`);
}

export function createRootRunner(globalRoot: string): CommandRunner {
  return async (argv) => {
    if (argv.join(" ") === "npm root -g") {
      return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
}
