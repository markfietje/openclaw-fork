// Reads package.json metadata needed by install and update flows.
import path from "node:path";
import { normalizeNullableString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { tryReadJson } from "./json-files.js";

type PackageJson = {
  bin?: unknown;
  name?: unknown;
  packageManager?: unknown;
  version?: unknown;
};

const PACKAGE_BIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** Reads safe executable names from npm's string or object bin manifest forms. */
export function parsePackageBinNames(manifest: Pick<PackageJson, "bin" | "name">): string[] {
  let entries: Array<[string, unknown]>;
  if (typeof manifest.bin === "string") {
    const packageName = normalizeString(manifest.name)?.split("/").at(-1) ?? "";
    entries = [[packageName, manifest.bin]];
  } else if (manifest.bin && typeof manifest.bin === "object" && !Array.isArray(manifest.bin)) {
    entries = Object.entries(manifest.bin as Record<string, unknown>);
  } else if (manifest.bin === undefined) {
    return [];
  } else {
    throw new Error("package bin manifest must be a string or object");
  }
  const names = entries.map(([name, target]) => {
    if (!PACKAGE_BIN_NAME_PATTERN.test(name) || typeof target !== "string" || !target.trim()) {
      throw new Error(`package declares an unsafe bin entry ${JSON.stringify(name)}`);
    }
    return name;
  });
  return [...new Set(names)].sort();
}

/** Reads package.json as a loose object, returning null for missing or invalid manifests. */
async function readPackageJson(root: string): Promise<PackageJson | null> {
  const parsed = await tryReadJson<unknown>(path.join(root, "package.json"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as PackageJson)
    : null;
}

/** Reads and trims the package version string, returning null for blank or non-string values. */
export async function readPackageVersion(root: string): Promise<string | null> {
  return normalizeString((await readPackageJson(root))?.version);
}

/** Reads package bin names, returning an empty list when the manifest is unavailable. */
export async function readPackageBinNames(root: string): Promise<string[]> {
  const manifest = await readPackageJson(root);
  return manifest ? parsePackageBinNames(manifest) : [];
}

/** Reads and trims the package name string, returning null for blank or non-string values. */
export async function readPackageName(root: string): Promise<string | null> {
  return normalizeString((await readPackageJson(root))?.name);
}

/** Reads and trims the packageManager spec, returning null for blank or non-string values. */
export async function readPackageManagerSpec(root: string): Promise<string | null> {
  return normalizeString((await readPackageJson(root))?.packageManager);
}
