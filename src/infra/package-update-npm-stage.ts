import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "./errors.js";
import { pathExists } from "./fs-safe.js";
import { resolvePackageRuntimeNpmPrefix } from "./package-runtime-env.js";
import type { PackageUpdateStepResult } from "./package-update-types.js";
import { movePathWithCopyFallback } from "./replace-file.js";
import {
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  resolveNpmGlobalPrefixLayoutFromPrefix,
  type NpmGlobalPrefixLayout,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

const PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS = "allow" as const;

export type StagedNpmInstall = {
  prefix: string;
  layout: NpmGlobalPrefixLayout;
  packageRoot: string;
  installTarget: ResolvedGlobalInstallTarget;
};

type NpmBinShimBackup = {
  backupDir: string;
  targetBinDir: string;
  entries: Array<{
    name: string;
    hadExisting: boolean;
  }>;
};

export async function removePackageUpdatePathBestEffort(targetPath: string): Promise<boolean> {
  try {
    await fs.rm(targetPath, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 5 : 2,
      retryDelay: 100,
    });
    return true;
  } catch {
    return false;
  }
}

function isUnambiguousNpmPrefixGlobalRoot(globalRoot: string | null): boolean {
  const trimmed = globalRoot?.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = path.resolve(trimmed);
  if (path.basename(normalized) !== "node_modules") {
    return false;
  }
  const parentDir = path.dirname(normalized);
  if (path.basename(parentDir) === "lib") {
    return true;
  }
  return process.platform === "win32" && path.basename(parentDir).toLowerCase() === "npm";
}

export function resolveStagedNpmTargetLayout(
  installTarget: ResolvedGlobalInstallTarget,
): NpmGlobalPrefixLayout | null {
  const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(installTarget.globalRoot, {
    allowDirectNodeModulesRoot: installTarget.directNodeModulesRoot === true,
  });
  if (!targetLayout) {
    return null;
  }
  if (
    installTarget.manager === "npm" ||
    isUnambiguousNpmPrefixGlobalRoot(installTarget.globalRoot)
  ) {
    return targetLayout;
  }
  return null;
}

function resolveSafePackageParts(packageName: string): string[] | null {
  const packageParts = packageName.split("/");
  const hasSafePackageName =
    packageParts.length > 0 &&
    packageParts.length <= 2 &&
    packageParts.every(
      (part) => part.length > 0 && part !== "." && part !== ".." && !part.includes("\\"),
    ) &&
    (packageParts.length === 1 || packageParts[0]?.startsWith("@"));
  return hasSafePackageName ? packageParts : null;
}

export function resolveNpmTargetFromKnownPackageRoot(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
  knownPackageRoot: string | null,
): ResolvedGlobalInstallTarget | null {
  const packageParts = resolveSafePackageParts(packageName);
  const packageRoot = knownPackageRoot?.trim();
  if (!packageParts || !packageRoot) {
    return null;
  }
  const normalizedPackageRoot = path.resolve(packageRoot);
  let globalRoot = path.dirname(normalizedPackageRoot);
  if (packageParts.length === 2) {
    globalRoot = path.dirname(globalRoot);
  }
  if (path.resolve(globalRoot, ...packageParts) !== normalizedPackageRoot) {
    return null;
  }
  const standardLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(globalRoot);
  const directLayout =
    standardLayout ??
    resolveNpmGlobalPrefixLayoutFromGlobalRoot(globalRoot, { allowDirectNodeModulesRoot: true });
  if (!directLayout) {
    return null;
  }
  return {
    manager: "npm",
    command: installTarget.command,
    globalRoot,
    packageRoot: normalizedPackageRoot,
    ...(standardLayout ? {} : { directNodeModulesRoot: true }),
  };
}

export function resolveNpmTargetFromInvocation(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
  npmCommandArgv: readonly string[],
): ResolvedGlobalInstallTarget | null {
  const prefix = resolvePackageRuntimeNpmPrefix(npmCommandArgv);
  const packageParts = resolveSafePackageParts(packageName);
  if (!prefix || !packageParts) {
    return null;
  }
  const layout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
  return {
    manager: "npm",
    command: installTarget.command,
    globalRoot: layout.globalRoot,
    packageRoot: path.join(layout.globalRoot, ...packageParts),
  };
}

async function createStagedNpmInstall(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
): Promise<StagedNpmInstall | null> {
  const targetLayout = resolveStagedNpmTargetLayout(installTarget);
  if (!targetLayout) {
    return null;
  }
  await fs.mkdir(targetLayout.globalRoot, { recursive: true });
  const prefix = await fs.mkdtemp(path.join(targetLayout.globalRoot, ".openclaw-update-stage-"));
  const layout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
  const packageRoot = path.join(layout.globalRoot, packageName);
  const command = installTarget.manager === "npm" ? installTarget.command : "npm";
  return {
    prefix,
    layout,
    packageRoot,
    installTarget: {
      manager: "npm",
      command,
      globalRoot: layout.globalRoot,
      packageRoot,
    },
  };
}

export async function prepareStagedNpmInstall(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
): Promise<{
  stagedInstall: StagedNpmInstall | null;
  failedStep: PackageUpdateStepResult | null;
}> {
  const startedAt = Date.now();
  try {
    const stagedInstall = await createStagedNpmInstall(installTarget, packageName);
    if (installTarget.manager === "npm" && !stagedInstall) {
      return {
        stagedInstall: null,
        failedStep: {
          name: "global install stage",
          command: "prepare staged npm install",
          cwd: installTarget.globalRoot ?? process.cwd(),
          durationMs: Date.now() - startedAt,
          exitCode: 1,
          stdoutTail: null,
          stderrTail: "cannot resolve npm global prefix layout for safe staged activation",
        },
      };
    }
    return {
      stagedInstall,
      failedStep: null,
    };
  } catch (err) {
    const targetLayout = resolveStagedNpmTargetLayout(installTarget);
    return {
      stagedInstall: null,
      failedStep: {
        name: "global install stage",
        command: "prepare staged npm install",
        cwd: targetLayout?.prefix ?? installTarget.globalRoot ?? process.cwd(),
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: formatErrorMessage(err),
      },
    };
  }
}

export async function cleanupStagedNpmInstall(stage: StagedNpmInstall | null): Promise<void> {
  if (!stage) {
    return;
  }
  await removePackageUpdatePathBestEffort(stage.prefix);
}

export function withNpmInvocation(
  argv: string[],
  installTarget: ResolvedGlobalInstallTarget,
  npmCommandArgv: readonly string[] | null,
): string[] {
  return installTarget.manager === "npm" && npmCommandArgv
    ? [...npmCommandArgv, ...argv.slice(1)]
    : argv;
}

async function copyPathEntry(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  await removePackageUpdatePathBestEffort(destination);
  if (stat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    await fs.cp(source, destination, {
      recursive: true,
      force: true,
      dereference: false,
      preserveTimestamps: false,
      verbatimSymlinks: true,
    });
    return;
  }
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stat.mode).catch(() => undefined);
}

async function replaceNpmBinShims(params: {
  stageLayout: NpmGlobalPrefixLayout;
  targetLayout: NpmGlobalPrefixLayout;
  packageName: string;
}): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(params.stageLayout.binDir);
  } catch {
    return;
  }

  const names = new Set([params.packageName, "openclaw"]);
  const shimEntries = entries.filter((entry) => {
    const parsed = path.parse(entry);
    return names.has(entry) || names.has(parsed.name);
  });
  if (shimEntries.length === 0) {
    return;
  }

  const backup: NpmBinShimBackup = {
    backupDir: await fs.mkdtemp(
      path.join(params.targetLayout.globalRoot, ".openclaw-shim-backup-"),
    ),
    targetBinDir: params.targetLayout.binDir,
    entries: [],
  };

  try {
    await fs.mkdir(params.targetLayout.binDir, { recursive: true });
    for (const entry of shimEntries) {
      const destination = path.join(params.targetLayout.binDir, entry);
      const hadExisting = await pathExists(destination);
      backup.entries.push({ name: entry, hadExisting });
      if (hadExisting) {
        await copyPathEntry(destination, path.join(backup.backupDir, entry));
      }
    }

    for (const entry of shimEntries) {
      await copyPathEntry(
        path.join(params.stageLayout.binDir, entry),
        path.join(params.targetLayout.binDir, entry),
      );
    }
  } catch (err) {
    await restoreNpmBinShimBackup(backup);
    throw err;
  } finally {
    await removePackageUpdatePathBestEffort(backup.backupDir);
  }
}

async function restoreNpmBinShimBackup(backup: NpmBinShimBackup): Promise<void> {
  await fs.mkdir(backup.targetBinDir, { recursive: true });
  for (const entry of backup.entries) {
    const destination = path.join(backup.targetBinDir, entry.name);
    await removePackageUpdatePathBestEffort(destination);
    if (entry.hadExisting) {
      await copyPathEntry(path.join(backup.backupDir, entry.name), destination);
    }
  }
}

export async function swapStagedNpmInstall(params: {
  stage: StagedNpmInstall;
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
}): Promise<PackageUpdateStepResult> {
  const startedAt = Date.now();
  const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(params.installTarget.globalRoot, {
    allowDirectNodeModulesRoot: params.installTarget.directNodeModulesRoot === true,
  });
  const targetPackageRoot = params.installTarget.packageRoot;
  if (!targetLayout || !targetPackageRoot) {
    return {
      name: "global install swap",
      command: "swap staged npm install",
      cwd: params.stage.prefix,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: "cannot resolve npm global prefix layout",
    };
  }

  const backupRoot = path.join(targetLayout.globalRoot, `.openclaw-${process.pid}-${Date.now()}`);
  let movedExisting = false;
  let movedStaged = false;
  let removedBackup = true;
  try {
    await fs.mkdir(targetLayout.globalRoot, { recursive: true });
    if (await pathExists(targetPackageRoot)) {
      await movePathWithCopyFallback({
        from: targetPackageRoot,
        sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
        to: backupRoot,
      });
      movedExisting = true;
    }
    await movePathWithCopyFallback({
      from: params.stage.packageRoot,
      sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
      to: targetPackageRoot,
    });
    movedStaged = true;
    if (params.installTarget.directNodeModulesRoot !== true) {
      await replaceNpmBinShims({
        stageLayout: params.stage.layout,
        targetLayout,
        packageName: params.packageName,
      });
    }
    if (movedExisting) {
      removedBackup = await removePackageUpdatePathBestEffort(backupRoot);
    }
    return {
      name: "global install swap",
      command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot}`,
      cwd: targetLayout.globalRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stdoutTail: movedExisting
        ? removedBackup
          ? `replaced ${params.packageName}`
          : `replaced ${params.packageName}; preserved old package at ${backupRoot} for delayed cleanup`
        : `installed ${params.packageName}`,
      stderrTail: null,
    };
  } catch (err) {
    if (movedStaged) {
      await removePackageUpdatePathBestEffort(targetPackageRoot);
    }
    if (movedExisting) {
      await movePathWithCopyFallback({
        from: backupRoot,
        sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
        to: targetPackageRoot,
      }).catch(() => undefined);
    }
    return {
      name: "global install swap",
      command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot}`,
      cwd: targetLayout.globalRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: formatErrorMessage(err),
    };
  }
}
