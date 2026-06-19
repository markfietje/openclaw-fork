// Core command handlers for SQLite snapshot artifacts.
import { createLocalSqliteSnapshotProvider } from "../snapshot/local-repository.js";
import type {
  SnapshotManifest,
  SnapshotSummary,
  SnapshotVerificationResult,
} from "../snapshot/snapshot-provider.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export interface SnapshotCreateOptions {
  readonly db?: string;
  readonly repository?: string;
  readonly id?: string;
  readonly kind?: string;
  readonly json?: boolean;
}

export interface SnapshotRepositoryOptions {
  readonly repository?: string;
  readonly json?: boolean;
}

export interface SnapshotJsonOptions {
  readonly json?: boolean;
}

export interface SnapshotRestoreOptions extends SnapshotJsonOptions {
  readonly target?: string;
}

type SnapshotCreateReport = {
  readonly ok: true;
  readonly snapshotPath: string;
  readonly manifest: SnapshotManifest;
};

type SnapshotVerifyReport = SnapshotVerificationResult & {
  readonly snapshotPath: string;
};

type SnapshotRestoreReport = SnapshotVerificationResult & {
  readonly snapshotPath: string;
  readonly targetPath: string;
};

type SnapshotListReport = {
  readonly ok: true;
  readonly snapshots: readonly SnapshotSummary[];
};

export async function snapshotCreateCommand(
  options: SnapshotCreateOptions,
  runtime: RuntimeEnv,
): Promise<number> {
  try {
    const repositoryPath = requireOption(options.repository, "--repository");
    const dbPath = requireOption(options.db, "--db");
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const result = await provider.create({
      path: dbPath,
      ...(options.id ? { id: options.id } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
    });
    writeCreateReport(
      { ok: true, snapshotPath: result.ref.path, manifest: result.manifest },
      options,
      runtime,
    );
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function snapshotVerifyCommand(
  snapshotPath: string,
  options: SnapshotJsonOptions,
  runtime: RuntimeEnv,
): Promise<number> {
  try {
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath: "." });
    const verified = await provider.verify({ path: requireValue(snapshotPath, "<snapshot>") });
    writeVerifyReport({ ...verified, snapshotPath }, options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function snapshotRestoreCommand(
  snapshotPath: string,
  options: SnapshotRestoreOptions,
  runtime: RuntimeEnv,
): Promise<number> {
  try {
    const targetPath = requireOption(options.target, "--target");
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath: "." });
    const verified = await provider.restore(
      { path: requireValue(snapshotPath, "<snapshot>") },
      targetPath,
    );
    writeRestoreReport({ ...verified, snapshotPath, targetPath }, options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function snapshotListCommand(
  options: SnapshotRepositoryOptions,
  runtime: RuntimeEnv,
): Promise<number> {
  try {
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: requireOption(options.repository, "--repository"),
    });
    writeListReport({ ok: true, snapshots: (await provider.list?.()) ?? [] }, options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

function writeCreateReport(
  report: SnapshotCreateReport,
  options: SnapshotJsonOptions,
  runtime: RuntimeEnv,
): void {
  if (options.json === true) {
    writeJson(report, runtime);
    return;
  }
  runtime.log(
    `snapshot create: ${report.snapshotPath} (${report.manifest.database.id}, ${report.manifest.artifact.sizeBytes} bytes)`,
  );
}

function writeVerifyReport(
  report: SnapshotVerifyReport,
  options: SnapshotJsonOptions,
  runtime: RuntimeEnv,
): void {
  if (options.json === true) {
    writeJson(report, runtime);
    return;
  }
  runtime.log(
    `snapshot verify: ok (${report.manifest.database.id}, ${report.manifest.artifact.sizeBytes} bytes)`,
  );
}

function writeRestoreReport(
  report: SnapshotRestoreReport,
  options: SnapshotJsonOptions,
  runtime: RuntimeEnv,
): void {
  if (options.json === true) {
    writeJson(report, runtime);
    return;
  }
  runtime.log(`snapshot restore: ${report.targetPath} (${report.manifest.database.id})`);
}

function writeListReport(
  report: SnapshotListReport,
  options: SnapshotJsonOptions,
  runtime: RuntimeEnv,
): void {
  if (options.json === true) {
    writeJson(report, runtime);
    return;
  }
  if (report.snapshots.length === 0) {
    runtime.log("snapshot list: no snapshots");
    return;
  }
  for (const snapshot of report.snapshots) {
    runtime.log(
      `${snapshot.manifest.createdAt} ${snapshot.manifest.database.id} ${snapshot.ref.path}`,
    );
  }
}

function writeJson(value: unknown, runtime: RuntimeEnv): void {
  writeRuntimeJson(runtime, value, 0);
}

function requireOption(value: string | undefined, flag: string): string {
  return requireValue(value, flag);
}

function requireValue(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required ${label} value.`);
  }
  return value;
}
