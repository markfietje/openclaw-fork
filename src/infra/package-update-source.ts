// Prepares source-backed package update specs before global installation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isGitPackageInstallSpec,
  isLocalDirectoryPackageInstallSpec,
  npmGitPackSourceAccessArgs,
  npmSourceAccessArgs,
} from "./package-manager-install-policy.js";
import type { PackageUpdateStepResult, PackageUpdateStepRunner } from "./package-update-types.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";

const NPM_PACK_QUIET_FLAGS = ["--json", "--loglevel=error"] as const;

async function findPackedTarball(packDir: string): Promise<string | null> {
  const entries = await fs.readdir(packDir).catch((): string[] => []);
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    return null;
  }
  return path.join(packDir, tarballs[0] ?? "");
}

export async function preparePackedPackageInstallSpec(params: {
  installTarget: ResolvedGlobalInstallTarget;
  installSpec: string;
  packageName: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  installCwd?: string;
  forcePack?: boolean;
  packCommand?: string | null;
}): Promise<{
  installSpec: string;
  packDir: string | null;
  steps: PackageUpdateStepResult[];
  failedStep: PackageUpdateStepResult | null;
}> {
  const isGitSource = isGitPackageInstallSpec(params.packageName, params.installSpec);
  const shouldPack =
    params.forcePack === true ||
    (params.installTarget.manager === "npm" &&
      (isGitSource || isLocalDirectoryPackageInstallSpec(params.packageName, params.installSpec)));
  if (!shouldPack) {
    return { installSpec: params.installSpec, packDir: null, steps: [], failedStep: null };
  }

  const packCommand =
    params.packCommand?.trim() ||
    (params.installTarget.manager === "npm" ? params.installTarget.command : null);
  if (!packCommand) {
    const failedStep: PackageUpdateStepResult = {
      name: "global update pack preflight",
      command: "resolve npm beside selected Node",
      cwd: params.installCwd ?? process.cwd(),
      durationMs: 0,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: "could not resolve npm beside the selected managed-service Node",
    };
    return {
      installSpec: params.installSpec,
      packDir: null,
      steps: [failedStep],
      failedStep,
    };
  }
  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pack-"));
  const sourceAccessArgs = isGitSource
    ? npmGitPackSourceAccessArgs(params.packageName, params.installSpec)
    : npmSourceAccessArgs(params.packageName, params.installSpec);
  const packStep = await params.runStep({
    name: "global update pack",
    argv: [
      packCommand,
      "pack",
      params.installSpec,
      ...sourceAccessArgs,
      "--pack-destination",
      packDir,
      ...NPM_PACK_QUIET_FLAGS,
    ],
    cwd: params.installCwd,
    env: params.env,
    timeoutMs: params.timeoutMs,
  });
  if (packStep.exitCode !== 0) {
    return {
      installSpec: params.installSpec,
      packDir,
      steps: [packStep],
      failedStep: packStep,
    };
  }

  const tarball = await findPackedTarball(packDir);
  if (!tarball) {
    const failedStep: PackageUpdateStepResult = {
      name: "global update pack verify",
      command: `find packed tarball in ${packDir}`,
      cwd: packDir,
      durationMs: 0,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: `expected exactly one .tgz from ${packCommand} pack ${params.installSpec}`,
    };
    return {
      installSpec: params.installSpec,
      packDir,
      steps: [packStep, failedStep],
      failedStep,
    };
  }

  return {
    installSpec: tarball,
    packDir,
    steps: [packStep],
    failedStep: null,
  };
}
