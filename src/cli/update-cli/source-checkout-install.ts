import { createPackageRuntimeEnv } from "../../infra/package-runtime-env.js";
import {
  resolvePackageRuntime,
  runPackageSourcePostinstall,
  runPackageSourceRuntimeGuard,
} from "../../infra/package-update-lifecycle.js";
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
      env: params.env,
      timeoutMs: params.timeoutMs,
      progress: params.progress,
    });
    return {
      steps: [installStep],
      failedStep: installStep.exitCode === 0 ? null : installStep,
    };
  }
  const selectedRuntime = await resolvePackageRuntime({
    nodePath: params.nodeRunner,
    runCommand,
    timeoutMs: params.timeoutMs,
    env: params.env,
    cwd: params.sourceRoot,
  });
  const runtimeGuardStep = await runPackageSourceRuntimeGuard(
    params.sourceRoot,
    selectedRuntime.version,
  );
  if (runtimeGuardStep.exitCode !== 0) {
    return { steps: [runtimeGuardStep], failedStep: runtimeGuardStep };
  }
  const installEnv = createPackageRuntimeEnv(params.env, selectedRuntime.nodePath);

  const installStep = await runUpdateStep({
    name: "global install",
    argv: globalInstallArgs(installTarget, params.sourceRoot),
    cwd: params.sourceRoot,
    ...(installEnv === undefined ? {} : { env: installEnv }),
    timeoutMs: params.timeoutMs,
    progress: params.progress,
  });
  const steps = [runtimeGuardStep, installStep];
  if (installStep.exitCode !== 0) {
    return {
      steps,
      failedStep: installStep,
    };
  }

  const postinstallStep = await runPackageSourcePostinstall({
    packageRoot: installTarget.packageRoot ?? params.currentPackageRoot,
    runStep: (step) =>
      runUpdateStep({
        ...step,
        ...(params.progress === undefined ? {} : { progress: params.progress }),
      }),
    timeoutMs: params.timeoutMs,
    ...(installEnv === undefined ? {} : { env: installEnv }),
    ...(selectedRuntime.nodePath === null ? {} : { nodePath: selectedRuntime.nodePath }),
  });
  steps.push(postinstallStep);
  return {
    steps,
    failedStep: postinstallStep.exitCode === 0 ? null : postinstallStep,
  };
}
