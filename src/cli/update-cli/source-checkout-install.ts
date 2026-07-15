import { readPackageBinNames } from "../../infra/package-json.js";
import { createPackageRuntimeEnv } from "../../infra/package-runtime-env.js";
import {
  resolvePackageRuntime,
  runPackageSourcePostinstall,
  runPackageSourceRuntimeGuard,
} from "../../infra/package-update-lifecycle.js";
import * as liveActivation from "../../infra/package-update-live-activation.js";
import { runGlobalPackageUpdateSteps } from "../../infra/package-update-steps.js";
import type { PackageUpdateStepResult } from "../../infra/package-update-types.js";
import {
  globalInstallArgs,
  resolveGlobalInstallTarget,
  resolvePnpmGlobalDirFromGlobalRoot,
} from "../../infra/update-global.js";
import type { UpdateStepProgress } from "../../infra/update-runner.js";
import { createGlobalCommandRunner, resolveGlobalManager, runUpdateStep } from "./shared.js";

/** Activates a trusted source checkout through the current global package manager. */
export async function runSourceCheckoutGlobalInstall(params: {
  sourceRoot: string;
  currentPackageRoot: string;
  installKind: "git" | "package" | "unknown";
  nodeRunner?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  progress?: UpdateStepProgress;
}): Promise<{
  steps: PackageUpdateStepResult[];
  failedStep: PackageUpdateStepResult | null;
}> {
  const runCommand = createGlobalCommandRunner();
  const manager = await resolveGlobalManager({
    root: params.currentPackageRoot,
    installKind: params.installKind,
    timeoutMs: params.timeoutMs,
  });
  const installTarget = await resolveGlobalInstallTarget({
    manager,
    runCommand,
    timeoutMs: params.timeoutMs,
    pkgRoot: params.currentPackageRoot,
  });
  if (installTarget.manager !== "npm") {
    const runtime = await resolvePackageRuntime({
      runCommand,
      timeoutMs: params.timeoutMs,
      ...(params.nodeRunner === undefined ? {} : { nodePath: params.nodeRunner }),
      env: params.env,
      cwd: params.sourceRoot,
    });
    const runtimeGuard = await runPackageSourceRuntimeGuard(params.sourceRoot, runtime.version);
    if (runtimeGuard.exitCode !== 0) {
      return { steps: [runtimeGuard], failedStep: runtimeGuard };
    }
    // pnpm and Bun activate the source checkout in place. Guard first, keep all
    // manager hooks disabled, then run only OpenClaw's known postinstall.
    const installEnv = createPackageRuntimeEnv(params.env, runtime.nodePath) ?? params.env;
    const binNames = [
      ...new Set([
        ...(await readPackageBinNames(params.currentPackageRoot)),
        ...(await readPackageBinNames(params.sourceRoot)),
      ]),
    ];
    const preparedRollback = await liveActivation.prepareLivePackageRollback({
      installTarget,
      binNames,
      runCommand,
      timeoutMs: params.timeoutMs,
      env: installEnv,
      cwd: params.sourceRoot,
    });
    if (preparedRollback.failedStep) {
      return {
        steps: [runtimeGuard, preparedRollback.failedStep],
        failedStep: preparedRollback.failedStep,
      };
    }
    const rollback = preparedRollback.rollback;
    try {
      const installStep = await runUpdateStep({
        name: "global install",
        argv: globalInstallArgs(
          installTarget,
          params.sourceRoot,
          undefined,
          installTarget.manager === "pnpm"
            ? resolvePnpmGlobalDirFromGlobalRoot(installTarget.globalRoot)
            : null,
        ),
        cwd: params.sourceRoot,
        env: installEnv,
        timeoutMs: params.timeoutMs,
        progress: params.progress,
      });
      const steps = [runtimeGuard, installStep];
      let failedStep: PackageUpdateStepResult | null = installStep.exitCode ? installStep : null;
      if (!failedStep) {
        const postinstallStep = await runPackageSourcePostinstall({
          packageRoot: params.sourceRoot,
          runStep: (step) =>
            runUpdateStep({
              ...step,
              ...(params.progress === undefined ? {} : { progress: params.progress }),
            }),
          timeoutMs: params.timeoutMs,
          env: installEnv,
          ...(runtime.nodePath === null ? {} : { nodePath: runtime.nodePath }),
        });
        steps.push(postinstallStep);
        failedStep = postinstallStep.exitCode ? postinstallStep : null;
      }
      const finalized = await liveActivation.finalizeLivePackageRollback(rollback, failedStep);
      if (finalized.rollbackStep) {
        steps.push(finalized.rollbackStep);
      }
      return { steps, failedStep: finalized.failedStep };
    } catch (error) {
      await liveActivation.throwAfterLivePackageRollback(rollback, error);
    }
  }
  const result = await runGlobalPackageUpdateSteps({
    installTarget,
    installSpec: params.sourceRoot,
    packageName: "openclaw",
    packageRoot: params.currentPackageRoot,
    runCommand,
    runStep: (step) =>
      runUpdateStep({
        ...step,
        ...(params.progress === undefined ? {} : { progress: params.progress }),
      }),
    timeoutMs: params.timeoutMs,
    env: params.env,
    installCwd: params.sourceRoot,
    ...(params.nodeRunner === undefined ? {} : { nodePath: params.nodeRunner }),
  });
  return {
    steps: result.steps,
    failedStep: result.failedStep,
  };
}
