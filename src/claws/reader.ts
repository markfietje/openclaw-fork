// Local package and development-manifest reader for Claws.
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { parseClawManifest } from "./schema.js";
import type { ClawDiagnostic, ClawReadResult, ClawSourceIdentity } from "./types.js";

type PackageJson = {
  name: string;
  version: string;
  openclaw: { claw: string };
};

type ResolvedClawSource = Omit<ClawSourceIdentity, "integrity"> & {
  manifestFormatPath: string;
};

const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CLAW_MARKDOWN_FILENAME = "CLAW.md";

function fileDiagnostic(code: string, message: string, path = "$"): ClawDiagnostic {
  return { level: "error", code, path, message };
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function parsePackageJson(value: unknown): PackageJson | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const openclaw = record.openclaw;
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return undefined;
  }
  const claw = (openclaw as Record<string, unknown>).claw;
  if (
    typeof record.name !== "string" ||
    record.name.trim() === "" ||
    typeof record.version !== "string" ||
    !EXACT_VERSION_PATTERN.test(record.version.trim()) ||
    typeof claw !== "string" ||
    claw.trim() === ""
  ) {
    return undefined;
  }
  return { name: record.name, version: record.version, openclaw: { claw } };
}

async function readJson(
  path: string,
  code: string,
): Promise<
  { ok: true; raw: string; value: unknown } | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      diagnostics: [fileDiagnostic(code, `Could not read ${path}: ${(error as Error).message}`)],
    };
  }
  try {
    return { ok: true, raw, value: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic("invalid_json", `Could not parse ${path}: ${(error as Error).message}`),
      ],
    };
  }
}

function parseClawMarkdown(
  raw: string,
  path: string,
): { ok: true; value: unknown } | { ok: false; diagnostics: ClawDiagnostic[] } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic(
          "missing_claw_frontmatter",
          `${path} must start with a YAML frontmatter block delimited by --- lines.`,
        ),
      ],
    };
  }
  const document = parseDocument(match[1], { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      ok: false,
      diagnostics: document.errors.map((error) =>
        fileDiagnostic("invalid_claw_frontmatter", `Could not parse ${path}: ${error.message}`),
      ),
    };
  }
  try {
    return { ok: true, value: document.toJSON() };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic(
          "invalid_claw_frontmatter",
          `Could not parse ${path}: ${(error as Error).message}`,
        ),
      ],
    };
  }
}

export function parseClawManifestDocument(
  raw: string,
  path: string,
): { ok: true; value: unknown } | { ok: false; diagnostics: ClawDiagnostic[] } {
  if (basename(path).toLowerCase() === CLAW_MARKDOWN_FILENAME.toLowerCase()) {
    return parseClawMarkdown(raw, path);
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic("invalid_json", `Could not parse ${path}: ${(error as Error).message}`),
      ],
    };
  }
}

async function readClawDocument(
  path: string,
  code: string,
  manifestFormatPath = path,
): Promise<
  { ok: true; raw: string; value: unknown } | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      diagnostics: [fileDiagnostic(code, `Could not read ${path}: ${(error as Error).message}`)],
    };
  }
  const parsed = parseClawManifestDocument(raw, manifestFormatPath);
  return parsed.ok ? { ...parsed, raw } : parsed;
}

async function resolvePackageSource(
  packageRoot: string,
): Promise<
  { ok: true; source: ResolvedClawSource } | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const packageRootReal = await realpath(packageRoot).catch(() => undefined);
  if (!packageRootReal) {
    return {
      ok: false,
      diagnostics: [fileDiagnostic("package_read_failed", `Could not resolve ${packageRoot}.`)],
    };
  }
  const packageJsonPath = resolve(packageRootReal, "package.json");
  const packageJsonResult = await readJson(packageJsonPath, "package_read_failed");
  if (!packageJsonResult.ok) {
    return packageJsonResult;
  }
  const packageJson = parsePackageJson(packageJsonResult.value);
  if (!packageJson) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic(
          "invalid_package_metadata",
          "package.json must declare non-empty name, version, and openclaw.claw fields.",
        ),
      ],
    };
  }
  if (isAbsolute(packageJson.openclaw.claw)) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic("manifest_escapes_package", "openclaw.claw must be package-relative."),
      ],
    };
  }
  const declaredManifestPath = resolve(packageRootReal, packageJson.openclaw.claw);
  const manifestPath = await realpath(declaredManifestPath).catch(() => undefined);
  if (!manifestPath || !isContained(packageRootReal, manifestPath)) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic(
          "manifest_escapes_package",
          "The declared Claw manifest must resolve inside its package root.",
        ),
      ],
    };
  }
  return {
    ok: true,
    source: {
      kind: "package",
      name: packageJson.name,
      version: packageJson.version,
      packageRoot: packageRootReal,
      manifestPath,
      manifestFormatPath: declaredManifestPath,
    },
  };
}

async function resolveSource(
  path: string,
): Promise<
  { ok: true; source: ResolvedClawSource } | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const inputPath = resolve(path);
  const inputStat = await stat(inputPath).catch(() => undefined);
  if (!inputStat) {
    return {
      ok: false,
      diagnostics: [fileDiagnostic("read_failed", `Could not resolve Claw source ${inputPath}.`)],
    };
  }
  if (inputStat.isDirectory()) {
    return resolvePackageSource(inputPath);
  }
  if (!inputStat.isFile()) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic("unsupported_source", "Claw source must be a file or directory."),
      ],
    };
  }

  const manifestPath = await realpath(inputPath);
  const packageRoot = await realpath(dirname(manifestPath));
  return {
    ok: true,
    source: {
      kind: "development",
      name: `local:${basename(manifestPath).replace(/\.json$/i, "")}`,
      version: "0.0.0-development",
      packageRoot,
      manifestPath,
      manifestFormatPath: inputPath,
    },
  };
}

export async function readClawManifestFile(path: string): Promise<ClawReadResult> {
  const sourceResult = await resolveSource(path);
  if (!sourceResult.ok) {
    return sourceResult;
  }
  const manifestResult = await readClawDocument(
    sourceResult.source.manifestPath,
    "read_failed",
    sourceResult.source.manifestFormatPath,
  );
  if (!manifestResult.ok) {
    return manifestResult;
  }
  const parsed = parseClawManifest(manifestResult.value);
  if (!parsed.ok) {
    return parsed;
  }
  const source: ClawSourceIdentity = {
    kind: sourceResult.source.kind,
    name: sourceResult.source.name,
    version: sourceResult.source.version,
    packageRoot: sourceResult.source.packageRoot,
    manifestPath: sourceResult.source.manifestPath,
    integrity: `sha256:${createHash("sha256").update(manifestResult.raw).digest("hex")}`,
  };
  return { ok: true, manifest: parsed.manifest, source, diagnostics: parsed.diagnostics };
}
