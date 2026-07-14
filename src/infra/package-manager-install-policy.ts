import hostedGitInfo from "hosted-git-info";

/** Identifies package-manager targets that are not registry tags or versions. */
export function isExplicitPackageInstallSpec(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return (
    /\.(?:tgz|tar\.gz)$/iu.test(trimmed) ||
    /^(?:\.{1,2}[\\/]|[\\/]|[a-z]:[\\/])/iu.test(trimmed) ||
    trimmed.includes("://") ||
    trimmed.includes("#") ||
    /^(?:bitbucket|file|gist|github|gitlab|git\+ssh|git\+https|git\+http|git\+file|npm):/i.test(
      trimmed,
    )
  );
}

function stripPackageAlias(packageName: string, spec: string): string {
  const normalized = spec.trim();
  const prefix = `${packageName.trim()}@`;
  return normalized.toLowerCase().startsWith(prefix.toLowerCase())
    ? normalized.slice(prefix.length).trim()
    : normalized;
}

/** Identifies registry tags and versions after removing the package-name alias. */
export function isRegistryPackageInstallSpec(packageName: string, spec: string): boolean {
  const target = stripPackageAlias(packageName, spec);
  return target.length > 0 && !isExplicitPackageInstallSpec(target);
}

function isHttpGitInstallSpec(value: string): boolean {
  if (hostedGitInfo.fromUrl(value) != null) {
    return true;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return false;
    }
    return url.pathname.replace(/\/+$/u, "").endsWith(".git");
  } catch {
    return false;
  }
}

function isGitInstallSpec(value: string): boolean {
  const [repo] = value.split("#", 1);
  const isGitHubShorthand = repo
    ? !repo.startsWith(".") &&
      !repo.startsWith("/") &&
      !repo.startsWith("@") &&
      repo.split("/").length === 2 &&
      repo.split("/").every((part) => /^[^\s/:@]+$/u.test(part))
    : false;
  return (
    hostedGitInfo.fromUrl(value) != null ||
    /^git\+(?:ssh|https|http|file):/i.test(value) ||
    /^git:/i.test(value) ||
    /^ssh:\/\//i.test(value) ||
    /^[^@\s]+@[^:\s]+:[^#\s]+(?:#.*)?$/u.test(value) ||
    isHttpGitInstallSpec(value) ||
    isGitHubShorthand
  );
}

/** Identifies git package specs after removing an optional package-name alias. */
export function isGitPackageInstallSpec(packageName: string, spec: string): boolean {
  return isGitInstallSpec(stripPackageAlias(packageName, spec));
}

/** Makes an exact Git commit safe for npm's metadata-only source probe. */
export function npmPackageMetadataInstallSpec(packageName: string, spec: string): string {
  const target = stripPackageAlias(packageName, spec);
  if (!isGitInstallSpec(target)) {
    return spec;
  }
  const hashIndex = target.indexOf("#");
  if (hashIndex === -1) {
    return spec;
  }
  const repository = target.slice(0, hashIndex);
  const selector = target.slice(hashIndex + 1);
  const [commit, ...qualifiers] = selector.split("::");
  if (!commit || !/^[a-f0-9]{40,64}$/iu.test(commit)) {
    return spec;
  }
  // Pacote in npm 10 prepares already-resolved hosted commits even with
  // ignore-scripts. The equivalent peel expression forces manifest-only clone.
  return `${repository}#${commit}^0${qualifiers.map((part) => `::${part}`).join("")}`;
}

/** Replaces a mutable git selector with the exact commit resolved by npm metadata. */
export function pinGitPackageInstallSpec(
  packageName: string,
  spec: string,
  commit: string,
): string | null {
  if (!/^[a-f0-9]{40,64}$/iu.test(commit)) {
    return null;
  }
  const target = stripPackageAlias(packageName, spec);
  if (!isGitInstallSpec(target)) {
    return null;
  }
  const hashIndex = target.indexOf("#");
  const repository = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const selector = hashIndex === -1 ? "" : target.slice(hashIndex + 1);
  const subdirSelectors = selector
    .split("::")
    .filter((part) => part.toLowerCase().startsWith("path:"));
  return `${repository}#${commit}${subdirSelectors.map((part) => `::${part}`).join("")}`;
}

/** Identifies local package directories that must be packed before a scripts-disabled install. */
export function isLocalDirectoryPackageInstallSpec(packageName: string, spec: string): boolean {
  const target = stripPackageAlias(packageName, spec);
  if (/\.(?:tgz|tar\.gz)$/iu.test(target)) {
    return false;
  }
  return /^(?:file:|\.{1,2}[\\/]|[\\/]|[a-z]:[\\/])/iu.test(target);
}

/** Grants npm 12 one-shot access only for the explicit root source being installed. */
export function npmSourceAccessArgs(packageName: string, spec: string): string[] {
  const target = stripPackageAlias(packageName, spec);
  if (isGitInstallSpec(target)) {
    return ["--allow-git=root"];
  }
  try {
    const url = new URL(target);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return ["--allow-remote=root"];
    }
  } catch {
    // Registry tags, versions, and local paths need no remote-source approval.
  }
  return [];
}

/** Grants npm 12 the access needed while packing an explicit git source. */
export function npmGitPackSourceAccessArgs(packageName: string, spec: string): string[] {
  if (!isGitPackageInstallSpec(packageName, spec)) {
    return [];
  }
  // npm resolves the selected root ref to a pinned commit, then fetches that
  // commit as a nested source. `root` blocks the second fetch, so packing the
  // already-selected repository needs `all` within this isolated command.
  return ["--allow-git=all"];
}
