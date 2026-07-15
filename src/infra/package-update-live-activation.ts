import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatErrorMessage } from "./errors.js";
import type { PackageUpdateStepResult } from "./package-update-types.js";
import { applyPathPrepend } from "./path-prepend.js";
import {
  resolvePnpmGlobalDirFromGlobalRoot,
  type CommandRunner,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

type LivePathSnapshot = {
  backupRoot: string | null;
  entryPath: string;
  existed: boolean;
  isDirectory: boolean;
  kind: "state-root" | "bin-entry";
  linkType: "file" | "junction" | null;
  linkTarget: string | null;
  targetPath: string;
};

export type LivePackageRollback = {
  active: boolean;
  backupDir: string;
  snapshots: LivePathSnapshot[];
};

export function createPackageManagerInstallEnv(
  target: ResolvedGlobalInstallTarget,
  env: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (target.manager !== "bun" || !target.globalRoot) {
    return env;
  }
  return {
    ...Object.fromEntries(
      Object.entries(env ?? process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    BUN_INSTALL_GLOBAL_DIR: path.dirname(target.globalRoot),
  };
}

function rollbackStep(params: {
  name: string;
  command: string;
  cwd: string;
  startedAt: number;
  error?: unknown;
  stdoutTail?: string;
}): PackageUpdateStepResult {
  return {
    name: params.name,
    command: params.command,
    cwd: params.cwd,
    durationMs: Date.now() - params.startedAt,
    exitCode: params.error === undefined ? 0 : 1,
    stdoutTail: params.error === undefined ? (params.stdoutTail ?? null) : null,
    stderrTail: params.error === undefined ? null : formatErrorMessage(params.error),
  };
}

function cleanEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env ?? process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function resolveManagerBinDir(params: {
  installTarget: ResolvedGlobalInstallTarget;
  runCommand: CommandRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<string> {
  const env = cleanEnv(params.env);
  if (params.installTarget.manager === "pnpm" && env.PNPM_HOME) {
    // pnpm 10 used PNPM_HOME directly; pnpm 11 uses its bin child.
    applyPathPrepend(env, [path.join(env.PNPM_HOME, "bin"), env.PNPM_HOME]);
  }
  const argv =
    params.installTarget.manager === "bun"
      ? [params.installTarget.command, "pm", "bin", "-g"]
      : [params.installTarget.command, "bin", "-g"];
  const result = await params.runCommand(argv, {
    timeoutMs: Math.min(params.timeoutMs, 10_000),
    ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
    env,
  });
  const binDir = result.code === 0 ? result.stdout.trim() : "";
  if (!binDir || !path.isAbsolute(binDir)) {
    throw new Error(
      `could not resolve ${params.installTarget.manager} global bin directory: ${result.stderr.trim() || "empty output"}`,
    );
  }
  return path.resolve(binDir);
}

function resolveManagerStateRoot(target: ResolvedGlobalInstallTarget): string {
  if (target.manager === "pnpm") {
    const globalDir = resolvePnpmGlobalDirFromGlobalRoot(target.globalRoot);
    if (globalDir) {
      return globalDir;
    }
  } else if (
    target.manager === "bun" &&
    path.basename(target.globalRoot ?? "") === "node_modules"
  ) {
    return path.dirname(target.globalRoot!);
  }
  throw new Error(`cannot resolve ${target.manager} global state root for safe live activation`);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveSnapshot(
  entryPath: string,
  kind: LivePathSnapshot["kind"],
): Promise<LivePathSnapshot> {
  try {
    const entryStat = await fs.lstat(entryPath);
    const linkTarget = entryStat.isSymbolicLink() ? await fs.readlink(entryPath) : null;
    let targetPath = entryPath;
    let targetStat = entryStat;
    if (linkTarget) {
      try {
        targetPath = await fs.realpath(entryPath);
        targetStat = await fs.stat(targetPath);
      } catch (error) {
        if (
          kind === "bin-entry" &&
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return {
            backupRoot: null,
            entryPath,
            existed: true,
            isDirectory: false,
            kind,
            linkType: "file",
            linkTarget,
            targetPath: path.resolve(path.dirname(entryPath), linkTarget),
          };
        }
        throw error;
      }
    }
    if (kind === "state-root" && !targetStat.isDirectory()) {
      throw new Error(`package-manager state root is not a directory: ${entryPath}`);
    }
    return {
      backupRoot: null,
      entryPath,
      existed: true,
      isDirectory: targetStat.isDirectory(),
      kind,
      linkType: linkTarget ? (targetStat.isDirectory() ? "junction" : "file") : null,
      linkTarget,
      targetPath,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        backupRoot: null,
        entryPath,
        existed: false,
        isDirectory: false,
        kind,
        linkType: null,
        linkTarget: null,
        targetPath: entryPath,
      };
    }
    throw error;
  }
}

function resolveBinEntryPaths(binDir: string, binNames: string[]): string[] {
  const entryPaths = new Map<string, string>();
  for (const binName of binNames) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(binName)) {
      throw new Error(`cannot snapshot unsafe package bin name ${JSON.stringify(binName)}`);
    }
    for (const suffix of ["", ".cmd", ".ps1", ".exe"]) {
      const entryPath = path.join(binDir, `${binName}${suffix}`);
      const key = process.platform === "win32" ? entryPath.toLowerCase() : entryPath;
      entryPaths.set(key, entryPath);
    }
  }
  return [...entryPaths.values()];
}

async function backupSnapshot(snapshot: LivePathSnapshot, backupDir: string, index: number) {
  if (!snapshot.existed || (snapshot.kind === "bin-entry" && snapshot.linkTarget)) {
    return;
  }
  snapshot.backupRoot = path.join(backupDir, `state-${index}`);
  const sourcePath = snapshot.kind === "state-root" ? snapshot.targetPath : snapshot.entryPath;
  await fs.cp(sourcePath, snapshot.backupRoot, {
    recursive: snapshot.isDirectory,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

export async function prepareLivePackageRollback(params: {
  installTarget: ResolvedGlobalInstallTarget;
  binNames: string[];
  runCommand: CommandRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<{
  rollback: LivePackageRollback | null;
  failedStep: PackageUpdateStepResult | null;
}> {
  const startedAt = Date.now();
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-rollback-"));
  try {
    const stateRoot = resolveManagerStateRoot(params.installTarget);
    if (stateRoot === path.parse(stateRoot).root) {
      throw new Error(`refusing to snapshot filesystem root for ${params.installTarget.manager}`);
    }
    const binDir = await resolveManagerBinDir(params);
    const stateSnapshot = await resolveSnapshot(stateRoot, "state-root");
    const binEntryPaths = resolveBinEntryPaths(binDir, params.binNames);
    const binSnapshots = await Promise.all(
      binEntryPaths.map((entryPath) => resolveSnapshot(entryPath, "bin-entry")),
    );
    // The manager state captures nested shims. External shims stay separate,
    // including symlinks whose targets point back into the manager state.
    const snapshots = [
      stateSnapshot,
      ...binSnapshots.filter(
        (snapshot) => !isPathInside(stateSnapshot.entryPath, snapshot.entryPath),
      ),
    ];
    for (const [index, snapshot] of snapshots.entries()) {
      await backupSnapshot(snapshot, backupDir, index);
    }
    if (!stateSnapshot.backupRoot) {
      throw new Error(`missing ${params.installTarget.manager} global state root ${stateRoot}`);
    }
    return { rollback: { active: true, backupDir, snapshots }, failedStep: null };
  } catch (error) {
    await fs.rm(backupDir, { recursive: true, force: true });
    const failedStep = rollbackStep({
      name: "global update rollback prepare",
      command: `backup ${params.installTarget.manager} global state`,
      cwd: params.cwd ?? process.cwd(),
      startedAt,
      error,
    });
    return { rollback: null, failedStep };
  }
}

export async function restoreLivePackageRollback(
  rollback: LivePackageRollback | null,
): Promise<PackageUpdateStepResult | null> {
  if (!rollback?.active) {
    return null;
  }
  const startedAt = Date.now();
  const restoredPaths = rollback.snapshots.map((snapshot) => snapshot.entryPath);
  try {
    for (const snapshot of rollback.snapshots.toSorted((left, right) =>
      left.kind === right.kind ? 0 : left.kind === "state-root" ? -1 : 1,
    )) {
      await fs.rm(snapshot.entryPath, { recursive: true, force: true });
      if (snapshot.kind === "state-root" && snapshot.targetPath !== snapshot.entryPath) {
        await fs.rm(snapshot.targetPath, { recursive: true, force: true });
      }
      if (!snapshot.existed) {
        continue;
      }
      if (snapshot.linkTarget) {
        await fs.mkdir(path.dirname(snapshot.entryPath), { recursive: true });
        if (snapshot.kind === "state-root") {
          if (!snapshot.backupRoot) {
            throw new Error(`missing rollback backup for ${snapshot.entryPath}`);
          }
          await fs.mkdir(path.dirname(snapshot.targetPath), { recursive: true });
          await fs.cp(snapshot.backupRoot, snapshot.targetPath, {
            recursive: true,
            errorOnExist: true,
            force: false,
            preserveTimestamps: true,
            verbatimSymlinks: true,
          });
        }
        await fs.symlink(snapshot.linkTarget, snapshot.entryPath, snapshot.linkType ?? "file");
        continue;
      }
      if (!snapshot.backupRoot) {
        throw new Error(`missing rollback backup for ${snapshot.entryPath}`);
      }
      const restorePath = snapshot.kind === "state-root" ? snapshot.targetPath : snapshot.entryPath;
      await fs.mkdir(path.dirname(restorePath), { recursive: true });
      await fs.cp(snapshot.backupRoot, restorePath, {
        recursive: snapshot.isDirectory,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    }
    rollback.active = false;
    await fs.rm(rollback.backupDir, { recursive: true, force: true }).catch(() => undefined);
    return rollbackStep({
      name: "global update rollback",
      command: `restore ${restoredPaths.join(", ")}`,
      cwd: path.dirname(restoredPaths[0] ?? process.cwd()),
      startedAt,
      stdoutTail: "restored previous package-manager state after rejected live activation",
    });
  } catch (error) {
    return rollbackStep({
      name: "global update rollback",
      command: `restore ${restoredPaths.join(", ")}`,
      cwd: path.dirname(restoredPaths[0] ?? process.cwd()),
      startedAt,
      error: new Error(
        `${formatErrorMessage(error)}; rollback backup preserved at ${rollback.backupDir}`,
      ),
    });
  }
}

export async function finalizeLivePackageRollback(
  rollback: LivePackageRollback | null,
  failedStep: PackageUpdateStepResult | null,
): Promise<{
  failedStep: PackageUpdateStepResult | null;
  rollbackStep: PackageUpdateStepResult | null;
}> {
  if (!failedStep) {
    await discardLivePackageRollback(rollback);
    return { failedStep: null, rollbackStep: null };
  }
  const rollbackStep = await restoreLivePackageRollback(rollback);
  return {
    failedStep: rollbackStep?.exitCode ? rollbackStep : failedStep,
    rollbackStep,
  };
}

export async function throwAfterLivePackageRollback(
  rollback: LivePackageRollback | null,
  error: unknown,
): Promise<never> {
  const rollbackStep = await restoreLivePackageRollback(rollback);
  if (rollbackStep?.exitCode) {
    throw new AggregateError([error, new Error(rollbackStep.stderrTail ?? "rollback failed")]);
  }
  throw error;
}

export async function discardLivePackageRollback(
  rollback: LivePackageRollback | null,
): Promise<void> {
  if (!rollback?.active) {
    return;
  }
  rollback.active = false;
  await fs.rm(rollback.backupDir, { recursive: true, force: true }).catch(() => undefined);
}
