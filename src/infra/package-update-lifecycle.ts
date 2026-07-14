import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import {
  packagePreinstallRuntime,
  type PackageCliNodeRuntime,
} from "../../scripts/preinstall-package-manager-warning.mjs";
import { formatErrorMessage } from "./errors.js";
import { pathExists } from "./fs-safe.js";
import { PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "./package-dist-inventory.js";
import type { PackageUpdateStepResult, PackageUpdateStepRunner } from "./package-update-types.js";
import { nodeVersionSatisfiesEngine } from "./runtime-guard.js";
import { compareValidSemver } from "./semver.js";
import type { CommandRunner } from "./update-global.js";

const PACKAGE_PREINSTALL_RELATIVE_PATH = "scripts/preinstall-package-manager-warning.mjs";
const PACKAGE_PREINSTALL_COMMAND = `node ${PACKAGE_PREINSTALL_RELATIVE_PATH}`;
const PACKAGE_POSTINSTALL_RELATIVE_PATH = "scripts/postinstall-bundled-plugins.mjs";
const PACKAGE_POSTINSTALL_COMMAND = `node ${PACKAGE_POSTINSTALL_RELATIVE_PATH}`;
const PACKED_PACKAGE_MANIFEST_PATH = "package/package.json";
const PACKED_PACKAGE_GUARD_PATH = `package/${PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`;
const PACKED_PACKAGE_PREINSTALL_PATH = `package/${PACKAGE_PREINSTALL_RELATIVE_PATH}`;
const PACKED_PACKAGE_POSTINSTALL_PATH = `package/${PACKAGE_POSTINSTALL_RELATIVE_PATH}`;
const MAX_PACKED_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const LEGACY_INSTALL_GUARD_COMPAT_MAX_VERSION = "2026.7.1";
const { probePackageCliNodeRuntime } = packagePreinstallRuntime;

// Packed releases omit the checkout-only prepare hook. Validate the published lifecycle
// contract before the package manager executes it and before any live activation.
const PACKAGE_LIFECYCLE_CONTRACT = {
  preinstall: PACKAGE_PREINSTALL_COMMAND,
  install: null,
  postinstall: PACKAGE_POSTINSTALL_COMMAND,
  prepare: null,
} as const;

/** Probes the Node selected for the updated install; managed services may not use process.execPath. */
export async function resolvePackageRuntime(params: {
  nodePath?: string;
  runCommand: CommandRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  probeNodeRuntime?: typeof probePackageCliNodeRuntime;
}): Promise<{ nodePath: string | null; version: string | null }> {
  if (!params.nodePath) {
    const env = params.env ?? process.env;
    const runtime = (params.probeNodeRuntime ?? probePackageCliNodeRuntime)({
      pathEnv: env.PATH ?? env.Path ?? "",
      cwd: params.cwd ?? process.cwd(),
    });
    return normalizePackageCliNodeRuntime(runtime);
  }
  const result = await params
    .runCommand([params.nodePath, "--version"], {
      timeoutMs: Math.min(params.timeoutMs, 10_000),
      ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      ...(params.env === undefined ? {} : { env: params.env }),
    })
    .catch(() => null);
  return {
    nodePath: params.nodePath,
    version: result?.code === 0 ? result.stdout.trim().replace(/^v/u, "") || null : null,
  };
}

function normalizePackageCliNodeRuntime(runtime: PackageCliNodeRuntime | null): {
  nodePath: string | null;
  version: string | null;
} {
  if (!runtime || runtime.bunVersion || !runtime.execPath || !runtime.version) {
    return { nodePath: null, version: null };
  }
  return { nodePath: runtime.execPath, version: runtime.version };
}

type CandidatePackageContract = {
  version: string | null;
  nodeEngine: string | null;
  preinstall: string | null;
  install: string | null;
  postinstall: string | null;
  prepare: string | null;
};

function parseCandidatePackageContract(value: string): CandidatePackageContract {
  const manifest = JSON.parse(value) as {
    version?: unknown;
    engines?: { node?: unknown };
    scripts?: Record<string, unknown>;
  };
  const lifecycleCommand = (name: keyof typeof PACKAGE_LIFECYCLE_CONTRACT): string | null => {
    const scriptValue = manifest.scripts?.[name];
    return typeof scriptValue === "string" ? scriptValue.trim() || null : null;
  };
  return {
    version: typeof manifest.version === "string" ? manifest.version.trim() || null : null,
    nodeEngine:
      typeof manifest.engines?.node === "string" ? manifest.engines.node.trim() || null : null,
    preinstall: lifecycleCommand("preinstall"),
    install: lifecycleCommand("install"),
    postinstall: lifecycleCommand("postinstall"),
    prepare: lifecycleCommand("prepare"),
  };
}

async function readCandidatePackageContract(
  packageRoot: string,
): Promise<CandidatePackageContract> {
  return parseCandidatePackageContract(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
}

async function readPackedCandidatePackageContract(tarballPath: string): Promise<{
  contract: CandidatePackageContract;
  hasGuard: boolean;
  hasPreinstall: boolean;
  hasPostinstall: boolean;
}> {
  const manifestChunks: Buffer[] = [];
  let manifestBytes = 0;
  let manifestCount = 0;
  const manifestState: { error: Error | null } = { error: null };
  let hasGuard = false;
  let hasPreinstall = false;
  let hasPostinstall = false;

  await tar.t({
    file: tarballPath,
    strict: true,
    onentry: (entry) => {
      const entryPath = entry.path.replace(/^\.\//u, "");
      if (entryPath === PACKED_PACKAGE_GUARD_PATH) {
        hasGuard = true;
      }
      if (entryPath === PACKED_PACKAGE_PREINSTALL_PATH) {
        hasPreinstall = true;
      }
      if (entryPath === PACKED_PACKAGE_POSTINSTALL_PATH) {
        hasPostinstall = true;
      }
      if (entryPath !== PACKED_PACKAGE_MANIFEST_PATH) {
        entry.resume();
        return;
      }

      manifestCount += 1;
      if (manifestCount > 1) {
        manifestState.error = new Error(
          `candidate package contains duplicate ${PACKED_PACKAGE_MANIFEST_PATH}`,
        );
        entry.resume();
        return;
      }
      if (entry.size > MAX_PACKED_PACKAGE_MANIFEST_BYTES) {
        manifestState.error = new Error(
          `staged package ${PACKED_PACKAGE_MANIFEST_PATH} is too large`,
        );
        entry.resume();
        return;
      }
      entry.on("data", (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        manifestBytes += buffer.byteLength;
        if (manifestBytes > MAX_PACKED_PACKAGE_MANIFEST_BYTES) {
          manifestState.error = new Error(
            `staged package ${PACKED_PACKAGE_MANIFEST_PATH} is too large`,
          );
          return;
        }
        manifestChunks.push(buffer);
      });
    },
  });

  if (manifestState.error) {
    throw manifestState.error;
  }
  if (manifestCount !== 1) {
    throw new Error(`candidate package is missing ${PACKED_PACKAGE_MANIFEST_PATH}`);
  }
  return {
    contract: parseCandidatePackageContract(Buffer.concat(manifestChunks).toString("utf8")),
    hasGuard,
    hasPreinstall,
    hasPostinstall,
  };
}

async function runPackedPackageContractGuard(params: {
  tarballPath: string;
  runtimeVersion: string | null;
  name: string;
  validate: (packed: Awaited<ReturnType<typeof readPackedCandidatePackageContract>>) => void;
}): Promise<PackageUpdateStepResult> {
  const startedAt = Date.now();
  try {
    const packed = await readPackedCandidatePackageContract(params.tarballPath);
    params.validate(packed);
    return {
      name: params.name,
      command: `validate ${params.tarballPath} ${PACKED_PACKAGE_MANIFEST_PATH} engines.node`,
      cwd: path.dirname(params.tarballPath),
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stdoutTail: `validated Node ${params.runtimeVersion} against ${packed.contract.nodeEngine}`,
      stderrTail: null,
    };
  } catch (error) {
    return {
      name: params.name,
      command: `validate ${params.tarballPath} ${PACKED_PACKAGE_MANIFEST_PATH} engines.node`,
      cwd: path.dirname(params.tarballPath),
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: formatErrorMessage(error),
    };
  }
}

export function validatePackageNodeEngine(
  nodeEngine: string | null,
  runtimeVersion: string | null,
): void {
  const satisfied = nodeVersionSatisfiesEngine(runtimeVersion, nodeEngine);
  if (satisfied === true) {
    return;
  }
  const requirement = nodeEngine
    ? `this OpenClaw release requires Node ${nodeEngine}`
    : "could not read this OpenClaw release's Node requirement";
  throw new Error(
    `${requirement}; detected Node ${runtimeVersion ?? "missing"}. Upgrade Node, then retry the OpenClaw update.`,
  );
}

function validateCandidatePackageContract(params: {
  contract: CandidatePackageContract;
  runtimeVersion: string | null;
  allowMissingGuardForVersion: string | null;
  hasGuard: boolean;
  hasPreinstall: boolean;
  hasPostinstall: boolean;
}): void {
  const legacyGuardComparison = params.contract.version
    ? compareValidSemver(params.contract.version, LEGACY_INSTALL_GUARD_COMPAT_MAX_VERSION)
    : null;
  const acceptsLegacyMissingGuard =
    !params.hasGuard &&
    params.allowMissingGuardForVersion !== null &&
    params.contract.version === params.allowMissingGuardForVersion &&
    legacyGuardComparison !== null &&
    legacyGuardComparison <= 0;
  if (!params.hasGuard && !acceptsLegacyMissingGuard) {
    throw new Error("candidate package is missing its package install guard");
  }
  validatePackageNodeEngine(params.contract.nodeEngine, params.runtimeVersion);
  for (const [lifecycleName, expected] of Object.entries(PACKAGE_LIFECYCLE_CONTRACT)) {
    const actual = params.contract[lifecycleName as keyof typeof PACKAGE_LIFECYCLE_CONTRACT];
    if (actual !== expected) {
      throw new Error(
        `candidate package declares unsupported ${lifecycleName} contract ${JSON.stringify(actual)}`,
      );
    }
  }
  if (!params.hasPreinstall) {
    throw new Error(`candidate package is missing ${PACKAGE_PREINSTALL_RELATIVE_PATH}`);
  }
  if (!params.hasPostinstall) {
    throw new Error(`candidate package is missing ${PACKAGE_POSTINSTALL_RELATIVE_PATH}`);
  }
}

/** Validates and consumes a guarded candidate without executing untrusted manager hooks. */
async function runPackageRuntimeGuard(
  packageRoot: string,
  runtimeVersion: string | null = process.versions.node ?? null,
  name = "global install runtime guard",
  allowMissingGuardForVersion: string | null = null,
): Promise<PackageUpdateStepResult> {
  const markerPath = path.join(packageRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH);
  const startedAt = Date.now();
  try {
    const contract = await readCandidatePackageContract(packageRoot);
    validateCandidatePackageContract({
      contract,
      runtimeVersion,
      allowMissingGuardForVersion,
      hasGuard: await pathExists(markerPath),
      hasPreinstall: await pathExists(path.join(packageRoot, PACKAGE_PREINSTALL_RELATIVE_PATH)),
      hasPostinstall: await pathExists(path.join(packageRoot, PACKAGE_POSTINSTALL_RELATIVE_PATH)),
    });
    await fs.rm(markerPath, { force: true });
    return {
      name,
      command: `validate ${path.join(packageRoot, "package.json")} engines.node`,
      cwd: packageRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stdoutTail: `validated Node ${runtimeVersion} against ${contract.nodeEngine}`,
      stderrTail: null,
    };
  } catch (error) {
    return {
      name,
      command: `validate ${path.join(packageRoot, "package.json")} engines.node`,
      cwd: packageRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: formatErrorMessage(error),
    };
  }
}

/** Validates a packed candidate before its package-manager lifecycle or live activation. */
export async function runPackedPackageRuntimeGuard(
  tarballPath: string,
  runtimeVersion: string | null,
  name = "global install runtime guard",
  allowMissingGuardForVersion: string | null = null,
): Promise<PackageUpdateStepResult> {
  return runPackedPackageContractGuard({
    tarballPath,
    runtimeVersion,
    name,
    validate: (packed) => {
      validateCandidatePackageContract({
        contract: packed.contract,
        runtimeVersion,
        allowMissingGuardForVersion,
        hasGuard: packed.hasGuard,
        hasPreinstall: packed.hasPreinstall,
        hasPostinstall: packed.hasPostinstall,
      });
    },
  });
}

/** Validates a trusted source checkout against the runtime that will launch the updated service. */
export async function runPackageSourceRuntimeGuard(
  packageRoot: string,
  runtimeVersion: string | null,
  name = "global install runtime guard",
): Promise<PackageUpdateStepResult> {
  const startedAt = Date.now();
  try {
    const contract = await readCandidatePackageContract(packageRoot);
    validatePackageNodeEngine(contract.nodeEngine, runtimeVersion);
    return {
      name,
      command: `validate ${path.join(packageRoot, "package.json")} engines.node`,
      cwd: packageRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stdoutTail: `validated Node ${runtimeVersion} against ${contract.nodeEngine}`,
      stderrTail: null,
    };
  } catch (error) {
    return {
      name,
      command: `validate ${path.join(packageRoot, "package.json")} engines.node`,
      cwd: packageRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: formatErrorMessage(error),
    };
  }
}

async function runPackagePostinstall(params: {
  packageRoot: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
}): Promise<PackageUpdateStepResult> {
  const scriptPath = path.join(params.packageRoot, PACKAGE_POSTINSTALL_RELATIVE_PATH);
  const nodePath = params.nodePath?.trim() || (!process.versions.bun ? process.execPath : null);
  if (!nodePath) {
    return {
      name: "global install postinstall",
      command: `run ${scriptPath}`,
      cwd: params.packageRoot,
      durationMs: 0,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: "could not resolve the real Node runtime for package postinstall",
    };
  }
  return params.runStep({
    name: "global install postinstall",
    argv: [nodePath, scriptPath],
    cwd: params.packageRoot,
    timeoutMs: params.timeoutMs,
    env: params.env,
  });
}

/** Runs the known OpenClaw postinstall after scripts-disabled trusted source activation. */
export async function runPackageSourcePostinstall(params: {
  packageRoot: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
}): Promise<PackageUpdateStepResult> {
  return runPackagePostinstall(params);
}

/** Runs only OpenClaw's validated root lifecycle after a scripts-disabled package install. */
export async function runPackageInstallLifecycle(params: {
  packageRoot: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  runtimeVersion?: string | null;
  nodePath?: string;
  allowMissingGuardForVersion?: string | null;
}): Promise<{
  steps: PackageUpdateStepResult[];
  failedStep: PackageUpdateStepResult | null;
}> {
  const guardStep = await runPackageRuntimeGuard(
    params.packageRoot,
    params.runtimeVersion === undefined ? (process.versions.node ?? null) : params.runtimeVersion,
    "global install runtime guard",
    params.allowMissingGuardForVersion ?? null,
  );
  if (guardStep.exitCode !== 0) {
    return { steps: [guardStep], failedStep: guardStep };
  }
  const postinstallStep = await runPackagePostinstall(params);
  return {
    steps: [guardStep, postinstallStep],
    failedStep: postinstallStep.exitCode === 0 ? null : postinstallStep,
  };
}
