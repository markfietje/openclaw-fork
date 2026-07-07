// Shared Git plugin install spec parser.
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveHomeRelativePath } from "./home-dir.js";

const GIT_SPEC_PREFIX = "git:";
const FULL_GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

/** Resolved Git source metadata persisted into plugin install records. */
export type GitPluginResolution = {
  url: string;
  ref?: string;
  commit?: string;
  resolvedAt: string;
};

/** Normalized Git plugin install spec accepted by the Git installer. */
export type ParsedGitPluginSpec = {
  input: string;
  url: string;
  ref?: string;
  label: string;
  normalizedSpec: string;
};

/** Returns true for full commit SHAs that do not require branch/tag drift checks. */
export function isImmutableGitCommitRef(ref: string | undefined): boolean {
  return FULL_GIT_COMMIT_PATTERN.test(ref ?? "");
}

function splitGitSpecRef(input: string): { base: string; ref?: string } {
  const hashIndex = input.lastIndexOf("#");
  if (hashIndex > 0) {
    return {
      base: input.slice(0, hashIndex),
      ref: normalizeOptionalString(input.slice(hashIndex + 1)),
    };
  }

  for (
    let atIndex = input.lastIndexOf("@");
    atIndex > 0;
    atIndex = input.lastIndexOf("@", atIndex - 1)
  ) {
    const base = input.slice(0, atIndex);
    const ref = normalizeOptionalString(input.slice(atIndex + 1));
    if (ref && isGitSpecBase(base)) {
      return { base, ref };
    }
  }

  return { base: input };
}

function isGitSpecBase(value: string): boolean {
  return (
    looksLikeGitHubRepoShorthand(value) ||
    looksLikeGitHubHostPath(value) ||
    looksLikeUrlGitSpecBase(value) ||
    looksLikeScpGitUrl(value) ||
    value.endsWith(".git") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/")
  );
}

function looksLikeGitHubRepoShorthand(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value);
}

function looksLikeGitHubHostPath(value: string): boolean {
  return /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(value);
}

function isGitUrl(value: string): boolean {
  return (
    /^(?:ssh|git|file):\/\//i.test(value) || looksLikeScpGitUrl(value) || value.endsWith(".git")
  );
}

function looksLikeScpGitUrl(value: string): boolean {
  return /^[^@\s]+@[^:\s]+:.+/.test(value);
}

function looksLikeUrlGitSpecBase(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ssh:", "git:", "file:"].includes(url.protocol)) {
      return false;
    }
    if (url.protocol === "file:") {
      return url.pathname.length > 1;
    }
    return Boolean(url.hostname) && url.pathname.length > 1;
  } catch {
    return false;
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function normalizeGitHubRepo(value: string): { url: string; label: string } {
  const repo = stripGitSuffix(value.replace(/^github\.com\//i, ""));
  return {
    url: `https://github.com/${repo}.git`,
    label: repo,
  };
}

function resolveLocalGitPath(value: string): string {
  return resolveHomeRelativePath(value);
}

function normalizeGitLabel(value: string): string {
  if (hasHttpUrlPrefix(value) || /^(?:ssh|git|file):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return stripGitSuffix(`${url.hostname}${url.pathname}`).replace(/^\/+/, "");
    } catch {
      return stripGitSuffix(value);
    }
  }
  return stripGitSuffix(value);
}

export function parseGitPluginSpec(raw: string): ParsedGitPluginSpec | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(GIT_SPEC_PREFIX)) {
    return null;
  }

  const body = trimmed.slice(GIT_SPEC_PREFIX.length).trim();
  if (!body) {
    return null;
  }

  const split = splitGitSpecRef(body);
  const base = split.base.trim();
  if (!base) {
    return null;
  }

  if (looksLikeGitHubRepoShorthand(base) || looksLikeGitHubHostPath(base)) {
    const normalized = normalizeGitHubRepo(base);
    return {
      input: trimmed,
      url: normalized.url,
      ref: split.ref,
      label: normalized.label,
      normalizedSpec: `${GIT_SPEC_PREFIX}${normalized.url}${split.ref ? `@${split.ref}` : ""}`,
    };
  }

  if (
    hasHttpUrlPrefix(base) ||
    isGitUrl(base) ||
    base.startsWith("./") ||
    base.startsWith("../") ||
    base.startsWith("~/")
  ) {
    const url =
      base.startsWith("./") || base.startsWith("../") || base.startsWith("~/")
        ? resolveLocalGitPath(base)
        : base;
    return {
      input: trimmed,
      url,
      ref: split.ref,
      label: normalizeGitLabel(url),
      normalizedSpec: `${GIT_SPEC_PREFIX}${url}${split.ref ? `@${split.ref}` : ""}`,
    };
  }

  return null;
}
