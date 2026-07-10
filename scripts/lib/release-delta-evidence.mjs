import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json.mjs";

export const RELEASE_DELTA_POLICY_SCHEMA = "openclaw.release-delta-policy/v1";
export const RELEASE_DELTA_MANIFEST_SCHEMA = "openclaw.release-delta-evidence/v1";

const SHA_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const DIGEST_RE = /^sha256:([0-9a-f]{64})$/u;
const POLICY_PATH_RE = /^\.github\/release-delta-policies\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;
const GIT_BINARY = process.platform === "win32" ? "git.exe" : "/usr/bin/git";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function exactObject(value, required, optional, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), `${label}.${key} is not allowed`);
  }
  for (const key of required) {
    assert(Object.hasOwn(value, key), `${label}.${key} is required`);
  }
}

function nonEmptyString(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
  return value;
}

function fullSha(value, label) {
  assert(typeof value === "string" && SHA_RE.test(value), `${label} must be a full lowercase SHA`);
  return value;
}

function sha256(value, label) {
  assert(typeof value === "string" && SHA256_RE.test(value), `${label} must be a SHA-256 hex`);
  return value;
}

function positiveInteger(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function sortedUniqueStrings(value, label, { allowEmpty = false } = {}) {
  assert(Array.isArray(value), `${label} must be an array`);
  const result = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  assert(allowEmpty || result.length > 0, `${label} must not be empty`);
  assert(new Set(result).size === result.length, `${label} must not contain duplicates`);
  return result.toSorted();
}

function validateRepositoryPath(value, label) {
  nonEmptyString(value, label);
  assert(!containsControlCharacter(value), `${label} must not contain control characters`);
  assert(value.normalize("NFC") === value, `${label} must use canonical UTF-8 normalization`);
  assert(!path.posix.isAbsolute(value), `${label} must be repository-relative`);
  assert(value === value.split("\\").join("/"), `${label} must use POSIX separators`);
  const normalized = path.posix.normalize(value);
  assert(normalized === value && !normalized.startsWith("../"), `${label} must be normalized`);
  return value;
}

function validateGlob(value, label) {
  nonEmptyString(value, label);
  assert(!value.startsWith("!"), `${label} must not be a negated glob`);
  assert(!value.includes("\\"), `${label} must use POSIX separators`);
  return value;
}

function matchesGlob(filePath, pattern) {
  return path.matchesGlob(filePath, pattern);
}

function matchesAny(filePath, patterns) {
  return patterns.some((pattern) => matchesGlob(filePath, pattern));
}

function decodeUtf8(value, label) {
  try {
    return UTF8_DECODER.decode(value);
  } catch {
    throw new Error(`${label} is not canonical UTF-8`);
  }
}

function parseBinding(value, label) {
  exactObject(value, ["path", "candidateShaPointer"], [], label);
  validateRepositoryPath(value.path, `${label}.path`);
  const candidateShaPointer = nonEmptyString(
    value.candidateShaPointer,
    `${label}.candidateShaPointer`,
  );
  assert(candidateShaPointer.startsWith("/"), `${label}.candidateShaPointer must be JSON Pointer`);
  return { path: value.path, candidateShaPointer };
}

function parsePackageMembers(value, label, requiredMembers, binding) {
  if (value === undefined) {
    return undefined;
  }
  exactObject(value, ["preflightManifest"], [], label);
  const preflightManifest = validateRepositoryPath(
    value.preflightManifest,
    `${label}.preflightManifest`,
  );
  assert(
    requiredMembers.includes(preflightManifest),
    `${label}.preflightManifest must be a required member`,
  );
  assert(
    binding.path === preflightManifest && binding.candidateShaPointer === "/releaseSha",
    `${label} must use /releaseSha from its preflight manifest as the candidate binding`,
  );
  return { preflightManifest };
}

function parseArtifactPolicy(value, label) {
  exactObject(value, ["key", "name", "requiredMembers", "binding"], ["packageMembers"], label);
  const requiredMembers = sortedUniqueStrings(
    value.requiredMembers,
    `${label}.requiredMembers`,
  ).map((entry, index) => validateRepositoryPath(entry, `${label}.requiredMembers[${index}]`));
  const binding = parseBinding(value.binding, `${label}.binding`);
  const packageMembers = parsePackageMembers(
    value.packageMembers,
    `${label}.packageMembers`,
    requiredMembers,
    binding,
  );
  assert(requiredMembers.includes(binding.path), `${label}.binding.path must be a required member`);
  return {
    key: nonEmptyString(value.key, `${label}.key`),
    name: nonEmptyString(value.name, `${label}.name`),
    requiredMembers,
    binding,
    ...(packageMembers ? { packageMembers } : {}),
  };
}

function parseValidationInputs(value, label) {
  exactObject(
    value,
    [
      "provider",
      "mode",
      "liveSuiteFilter",
      "crossOsSuiteFilter",
      "releasePackageSpec",
      "packageAcceptancePackageSpec",
      "codexPluginSpec",
    ],
    [],
    label,
  );
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      assert(typeof entry === "string", `${label}.${key} must be a string`);
      return [key, entry];
    }),
  );
}

function parseGatePolicy(value, index) {
  const label = `policy.gates[${index}]`;
  exactObject(
    value,
    ["id", "kind", "reuse", "workflowPath", "workflowSha", "jobName", "impactPaths", "artifacts"],
    ["validationInputs"],
    label,
  );
  assert(
    ["generic", "source-frv", "source-npm", "root-package"].includes(value.kind),
    `${label}.kind is invalid`,
  );
  assert(["never", "when-unimpacted"].includes(value.reuse), `${label}.reuse is invalid`);
  const impactPaths = sortedUniqueStrings(value.impactPaths, `${label}.impactPaths`, {
    allowEmpty: true,
  }).map((entry, patternIndex) => validateGlob(entry, `${label}.impactPaths[${patternIndex}]`));
  assert(
    Array.isArray(value.artifacts) && value.artifacts.length > 0,
    `${label}.artifacts is empty`,
  );
  const artifacts = value.artifacts.map((artifact, artifactIndex) =>
    parseArtifactPolicy(artifact, `${label}.artifacts[${artifactIndex}]`),
  );
  assert(
    new Set(artifacts.map((artifact) => artifact.key)).size === artifacts.length,
    `${label}.artifacts keys must be unique`,
  );
  assert(
    new Set(artifacts.map((artifact) => artifact.name)).size === artifacts.length,
    `${label}.artifacts names must be unique`,
  );
  const validationInputs =
    value.kind === "source-frv"
      ? parseValidationInputs(value.validationInputs, `${label}.validationInputs`)
      : undefined;
  assert(
    value.kind === "source-frv" || value.validationInputs === undefined,
    `${label}.validationInputs is only valid for source-frv`,
  );
  return {
    id: nonEmptyString(value.id, `${label}.id`),
    kind: value.kind,
    reuse: value.reuse,
    workflowPath: validateRepositoryPath(value.workflowPath, `${label}.workflowPath`),
    workflowSha: fullSha(value.workflowSha, `${label}.workflowSha`),
    jobName: nonEmptyString(value.jobName, `${label}.jobName`),
    impactPaths,
    artifacts,
    ...(validationInputs ? { validationInputs } : {}),
  };
}

export function validateReleaseDeltaPolicyPath(policyPath) {
  assert(
    POLICY_PATH_RE.test(policyPath),
    "policy path must name one JSON file under release-delta-policies",
  );
  return policyPath;
}

export function parseReleaseDeltaPolicy(input) {
  const value =
    typeof input === "string"
      ? JSON.parse(input)
      : Buffer.isBuffer(input)
        ? JSON.parse(decodeUtf8(input, "release delta policy"))
        : input;
  exactObject(
    value,
    ["schema", "release", "targetRef", "sourceSha", "allowedPaths", "metadataPaths", "gates"],
    [],
    "policy",
  );
  assert(value.schema === RELEASE_DELTA_POLICY_SCHEMA, "policy.schema is invalid");
  exactObject(value.release, ["version", "channel"], [], "policy.release");
  assert(value.release.channel === "beta", "policy.release.channel must be beta");
  assert(
    /^\d{4}\.\d+\.\d+-beta\.[1-9]\d*$/u.test(value.release.version),
    "policy.release.version must be a beta version",
  );
  const stableVersion = value.release.version.replace(/-beta\.[1-9]\d*$/u, "");
  assert(
    value.targetRef === `release/${stableVersion}`,
    "policy.targetRef must match the beta stable version",
  );
  const allowedPaths = sortedUniqueStrings(value.allowedPaths, "policy.allowedPaths").map(
    (entry, index) => validateGlob(entry, `policy.allowedPaths[${index}]`),
  );
  const metadataPaths = sortedUniqueStrings(value.metadataPaths, "policy.metadataPaths", {
    allowEmpty: true,
  }).map((entry, index) => validateGlob(entry, `policy.metadataPaths[${index}]`));
  const gates = value.gates.map(parseGatePolicy);
  assert(
    new Set(gates.map((gate) => gate.id)).size === gates.length,
    "policy gate ids must be unique",
  );
  assert(
    canonicalJson(allowedPaths) === canonicalJson(["CHANGELOG.md"]),
    "v1 policy allows only CHANGELOG.md",
  );
  assert(
    canonicalJson(metadataPaths) === canonicalJson(["CHANGELOG.md"]),
    "v1 policy metadataPaths must be CHANGELOG.md",
  );
  for (const kind of ["source-frv", "source-npm", "root-package"]) {
    assert(
      gates.filter((gate) => gate.kind === kind).length === 1,
      `policy must contain exactly one ${kind} gate`,
    );
  }
  for (const kind of ["source-npm", "root-package"]) {
    const packageArtifacts = gates
      .find((gate) => gate.kind === kind)
      .artifacts.filter((artifact) => artifact.packageMembers);
    assert(
      packageArtifacts.length === 1,
      `${kind} gate must contain exactly one packageMembers artifact`,
    );
  }
  assert(
    gates.find((gate) => gate.kind === "source-frv").reuse === "when-unimpacted",
    "source-frv gate must be reusable when unimpacted",
  );
  assert(
    gates.find((gate) => gate.kind === "source-npm").reuse === "when-unimpacted",
    "source-npm gate must be reusable when unimpacted",
  );
  assert(
    gates.find((gate) => gate.kind === "root-package").reuse === "when-unimpacted",
    "root-package freshness must derive from the changelog package rule",
  );
  return {
    schema: value.schema,
    release: {
      version: value.release.version,
      channel: "beta",
    },
    targetRef: nonEmptyString(value.targetRef, "policy.targetRef"),
    sourceSha: fullSha(value.sourceSha, "policy.sourceSha"),
    allowedPaths,
    metadataPaths,
    gates,
  };
}

function isolatedGitEnvironment() {
  const environment = { ...process.env };
  for (const variable of Object.keys(environment)) {
    if (variable === "GIT_CONFIG" || variable.startsWith("GIT_CONFIG_")) {
      delete environment[variable];
    }
  }
  for (const variable of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
  ]) {
    delete environment[variable];
  }
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    NO_COLOR: "1",
  };
}

function gitArgs(args) {
  return ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, ...args];
}

function git(cwd, args, encoding = "utf8") {
  return execFileSync(GIT_BINARY, gitArgs(args), {
    cwd,
    encoding,
    env: isolatedGitEnvironment(),
    maxBuffer: 128 * 1024 * 1024,
  });
}

function gitSucceeds(cwd, args) {
  return (
    spawnSync(GIT_BINARY, gitArgs(args), {
      cwd,
      env: isolatedGitEnvironment(),
      stdio: "ignore",
    }).status === 0
  );
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nulList(value) {
  return decodeUtf8(value, "git path output").split("\0").filter(Boolean);
}

function filteredTreeHash(cwd, commitSha, metadataPaths) {
  const entries = nulList(git(cwd, ["ls-tree", "-r", "-z", "--full-tree", commitSha], "buffer"));
  const filtered = entries.filter((entry) => {
    const tab = entry.indexOf("\t");
    assert(tab > 0, "git ls-tree output is invalid");
    return !matchesAny(entry.slice(tab + 1), metadataPaths);
  });
  return hashBytes(Buffer.from(`${filtered.join("\0")}${filtered.length > 0 ? "\0" : ""}`));
}

function resolvePointer(document, pointer, label) {
  if (pointer === "") {
    return document;
  }
  let value = document;
  for (const token of pointer
    .slice(1)
    .split("/")
    .map((entry) => entry.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    assert(value !== null && typeof value === "object", `${label} does not resolve`);
    assert(Object.hasOwn(value, token), `${label} does not resolve`);
    value = value[token];
  }
  return value;
}

function normalizeCommitVerification(value, sha) {
  exactObject(value, ["verified", "reason", "verifiedAt"], [], `commit verification ${sha}`);
  assert(value.verified === true, `delta commit ${sha} is not verified`);
  assert(value.reason === "valid", `delta commit ${sha} verification reason is not valid`);
  nonEmptyString(value.verifiedAt, `commit verification ${sha}.verifiedAt`);
  assert(
    !Number.isNaN(Date.parse(value.verifiedAt)),
    `commit verification ${sha}.verifiedAt is invalid`,
  );
  return {
    verified: true,
    reason: "valid",
    verifiedAt: value.verifiedAt,
  };
}

function gatePlan(policy, changedPaths) {
  return policy.gates.map((gate) => {
    const impactedPaths = changedPaths.filter((filePath) => matchesAny(filePath, gate.impactPaths));
    const changelogForcesFresh =
      gate.kind === "root-package" && changedPaths.includes("CHANGELOG.md");
    const mode =
      gate.reuse === "never" || impactedPaths.length > 0 || changelogForcesFresh
        ? "fresh"
        : "reuse";
    const reason =
      mode === "reuse"
        ? "No changed path matches this gate; source evidence is reused directly."
        : changelogForcesFresh
          ? "CHANGELOG.md is packed in the root npm artifact, so exact-target package proof is fresh."
          : gate.reuse === "never"
            ? "Policy requires exact-target evidence for this gate."
            : `Changed paths require exact-target evidence: ${impactedPaths.join(", ")}`;
    return {
      id: gate.id,
      mode,
      impactedPaths,
      reason,
    };
  });
}

export function computeReleaseDelta(cwd, policyInput, targetShaInput, branchTipShaInput) {
  const policy = parseReleaseDeltaPolicy(policyInput);
  const sourceSha = fullSha(policy.sourceSha, "source SHA");
  const targetSha = fullSha(targetShaInput, "target SHA");
  const branchTipSha = fullSha(branchTipShaInput, "target branch tip SHA");
  assert(targetSha === branchTipSha, "target SHA is not the current target branch tip");
  assert(
    gitSucceeds(cwd, ["cat-file", "-e", `${sourceSha}^{commit}`]),
    "source commit is unavailable",
  );
  assert(
    gitSucceeds(cwd, ["cat-file", "-e", `${targetSha}^{commit}`]),
    "target commit is unavailable",
  );
  assert(
    gitSucceeds(cwd, ["merge-base", "--is-ancestor", sourceSha, targetSha]),
    "source is not an ancestor of target",
  );

  const commitShas = git(cwd, ["rev-list", "--reverse", `${sourceSha}..${targetSha}`])
    .trim()
    .split("\n")
    .filter(Boolean);
  assert(commitShas.length > 0, "source and target must differ");
  const commits = [];
  let expectedParent = sourceSha;
  for (const [index, commitSha] of commitShas.entries()) {
    const [sha, parents, treeSha] = git(cwd, ["show", "-s", "--format=%H%x00%P%x00%T", commitSha])
      .trimEnd()
      .split("\0");
    const parentShas = parents.split(" ").filter(Boolean);
    assert(sha === commitSha, `delta commit ${index} identity changed`);
    assert(parentShas.length === 1, `delta commit ${sha} is not linear`);
    assert(
      parentShas[0] === expectedParent,
      `delta commit ${sha} does not follow the prior commit`,
    );
    const commitChangedPaths = nulList(
      git(cwd, ["diff", "--name-only", "-z", "--no-renames", parentShas[0], sha], "buffer"),
    ).toSorted();
    assert(commitChangedPaths.length > 0, `delta commit ${sha} changes no paths`);
    for (const filePath of commitChangedPaths) {
      validateRepositoryPath(filePath, `delta commit ${sha} path`);
      assert(
        matchesAny(filePath, policy.allowedPaths),
        `delta commit ${sha} changed a path not allowed by policy: ${filePath}`,
      );
    }
    commits.push({
      sha,
      parentSha: parentShas[0],
      treeSha: fullSha(treeSha, `tree ${sha}`),
      changedPaths: commitChangedPaths,
    });
    expectedParent = sha;
  }
  assert(expectedParent === targetSha, "delta history does not terminate at target");

  const changedPaths = nulList(
    git(cwd, ["diff", "--name-only", "-z", "--no-renames", sourceSha, targetSha], "buffer"),
  ).toSorted();
  assert(changedPaths.length > 0, "delta contains no changed paths");
  assert(new Set(changedPaths).size === changedPaths.length, "delta changed paths are duplicated");
  for (const filePath of changedPaths) {
    validateRepositoryPath(filePath, `changed path ${filePath}`);
    assert(
      matchesAny(filePath, policy.allowedPaths),
      `changed path is not allowed by policy: ${filePath}`,
    );
  }
  assert(
    canonicalJson(changedPaths) === canonicalJson(["CHANGELOG.md"]),
    "v1 supports only a CHANGELOG.md-only delta",
  );

  const sourceTreeSha = fullSha(
    git(cwd, ["rev-parse", `${sourceSha}^{tree}`]).trim(),
    "source tree SHA",
  );
  const targetTreeSha = fullSha(
    git(cwd, ["rev-parse", `${targetSha}^{tree}`]).trim(),
    "target tree SHA",
  );
  const sourceReusableTreeSha256 = filteredTreeHash(cwd, sourceSha, policy.metadataPaths);
  const targetReusableTreeSha256 = filteredTreeHash(cwd, targetSha, policy.metadataPaths);
  const gates = gatePlan(policy, changedPaths);
  if (gates.some((gate) => gate.mode === "reuse")) {
    assert(
      sourceReusableTreeSha256 === targetReusableTreeSha256,
      "reusable tree differs after metadata exclusions",
    );
  }
  if (changedPaths.includes("CHANGELOG.md")) {
    assert(
      policy.gates.some((gate) => gate.kind === "root-package"),
      "CHANGELOG.md changed without a root-package gate",
    );
  }

  return {
    source: {
      sha: sourceSha,
      treeSha: sourceTreeSha,
      reusableTreeSha256: sourceReusableTreeSha256,
    },
    target: {
      ref: policy.targetRef,
      sha: targetSha,
      treeSha: targetTreeSha,
      reusableTreeSha256: targetReusableTreeSha256,
    },
    commits,
    changedPaths,
    diffSha256: hashBytes(
      git(
        cwd,
        ["diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", sourceSha, targetSha],
        "buffer",
      ),
    ),
    metadataPaths: policy.metadataPaths,
    gates,
  };
}

function gateRunExpectation(gate, delta) {
  if (gate.kind === "source-npm") {
    return { headBranch: delta.target.ref, headSha: delta.source.sha };
  }
  if (gate.kind === "root-package") {
    return { headBranch: delta.target.ref, headSha: delta.target.sha };
  }
  return { headBranch: "main", headSha: gate.workflowSha };
}

function normalizeRun(value, gate, repository, delta) {
  exactObject(
    value,
    [
      "id",
      "runAttempt",
      "name",
      "path",
      "event",
      "headBranch",
      "headRepository",
      "headSha",
      "url",
      "status",
      "conclusion",
    ],
    [],
    `gate ${gate.id} run`,
  );
  assert(value.path === gate.workflowPath, `gate ${gate.id} run workflow differs from policy`);
  assert(value.headRepository === repository, `gate ${gate.id} run head repository differs`);
  const expected = gateRunExpectation(gate, delta);
  assert(value.headSha === expected.headSha, `gate ${gate.id} run head SHA differs`);
  assert(value.event === "workflow_dispatch", `gate ${gate.id} run event is not workflow_dispatch`);
  assert(value.headBranch === expected.headBranch, `gate ${gate.id} run head branch differs`);
  assert(
    value.status === "completed" && value.conclusion === "success",
    `gate ${gate.id} run is not successful`,
  );
  assert(value.runAttempt === 1, `gate ${gate.id} run attempt must be 1`);
  return {
    id: positiveInteger(value.id, `gate ${gate.id} run id`),
    runAttempt: positiveInteger(value.runAttempt, `gate ${gate.id} run attempt`),
    name: nonEmptyString(value.name, `gate ${gate.id} run name`),
    path: value.path,
    event: nonEmptyString(value.event, `gate ${gate.id} run event`),
    headBranch: nonEmptyString(value.headBranch, `gate ${gate.id} run head branch`),
    headRepository: value.headRepository,
    headSha: fullSha(value.headSha, `gate ${gate.id} run head SHA`),
    url: nonEmptyString(value.url, `gate ${gate.id} run URL`),
    status: "completed",
    conclusion: "success",
  };
}

function normalizeJob(value, gate, run) {
  exactObject(
    value,
    ["id", "runId", "runAttempt", "name", "headSha", "url", "status", "conclusion"],
    [],
    `gate ${gate.id} job`,
  );
  assert(
    value.runId === run.id && value.runAttempt === run.runAttempt,
    `gate ${gate.id} job run differs`,
  );
  assert(value.name === gate.jobName, `gate ${gate.id} job name differs from policy`);
  assert(value.headSha === run.headSha, `gate ${gate.id} job head SHA differs`);
  assert(
    value.status === "completed" && value.conclusion === "success",
    `gate ${gate.id} job is not successful`,
  );
  return {
    id: positiveInteger(value.id, `gate ${gate.id} job id`),
    runId: run.id,
    runAttempt: run.runAttempt,
    name: value.name,
    headSha: fullSha(value.headSha, `gate ${gate.id} job head SHA`),
    url: nonEmptyString(value.url, `gate ${gate.id} job URL`),
    status: "completed",
    conclusion: "success",
  };
}

function normalizeNpmPreflightManifest(
  document,
  artifactPolicy,
  files,
  expectedSha,
  release,
  gate,
) {
  const label = `gate ${gate.id} npm preflight manifest`;
  exactObject(
    document,
    [
      "version",
      "releaseTag",
      "releaseSha",
      "npmDistTag",
      "packageName",
      "packageVersion",
      "tarballName",
      "tarballSha256",
      "dependencyTarballs",
      "dependencyEvidenceDir",
      "dependencyEvidenceManifest",
    ],
    [],
    label,
  );
  assert(document.version === 1, `${label} version is invalid`);
  assert(document.releaseTag === `v${release.version}`, `${label} release tag differs`);
  assert(document.releaseSha === expectedSha, `${label} release SHA differs`);
  assert(document.npmDistTag === release.channel, `${label} npm dist-tag differs`);
  assert(document.packageName === "openclaw", `${label} root package name differs`);
  assert(document.packageVersion === release.version, `${label} root package version differs`);
  assert(
    document.dependencyEvidenceDir === "dependency-evidence" &&
      document.dependencyEvidenceManifest ===
        "dependency-evidence/dependency-evidence-manifest.json",
    `${label} dependency evidence paths differ`,
  );
  const rootTarballPath = validateRepositoryPath(document.tarballName, `${label}.tarballName`);
  assert(
    path.posix.basename(rootTarballPath) === rootTarballPath && rootTarballPath.endsWith(".tgz"),
    `${label} root tarball name is invalid`,
  );
  sha256(document.tarballSha256, `${label}.tarballSha256`);
  const rootTarballBytes = files.get(rootTarballPath);
  assert(Buffer.isBuffer(rootTarballBytes), `${label} root tarball is missing`);
  assert(
    hashBytes(rootTarballBytes) === document.tarballSha256,
    `${label} root tarball digest differs`,
  );
  assert(
    Array.isArray(document.dependencyTarballs),
    `${label}.dependencyTarballs must be an array`,
  );
  const dependencyTarballs = document.dependencyTarballs
    .map((dependency, index) => {
      const dependencyLabel = `${label}.dependencyTarballs[${index}]`;
      exactObject(
        dependency,
        ["packageName", "packageVersion", "tarballName", "tarballSha256"],
        [],
        dependencyLabel,
      );
      const packageName = nonEmptyString(dependency.packageName, `${dependencyLabel}.packageName`);
      assert(
        packageName.startsWith("@openclaw/"),
        `${dependencyLabel}.packageName must be an OpenClaw package`,
      );
      assert(
        dependency.packageVersion === release.version,
        `${dependencyLabel}.packageVersion differs`,
      );
      const tarballPath = validateRepositoryPath(
        dependency.tarballName,
        `${dependencyLabel}.tarballName`,
      );
      assert(
        path.posix.basename(tarballPath) === tarballPath && tarballPath.endsWith(".tgz"),
        `${dependencyLabel}.tarballName is invalid`,
      );
      sha256(dependency.tarballSha256, `${dependencyLabel}.tarballSha256`);
      const bytes = files.get(tarballPath);
      assert(Buffer.isBuffer(bytes), `${dependencyLabel} tarball is missing`);
      assert(
        hashBytes(bytes) === dependency.tarballSha256,
        `${dependencyLabel} tarball digest differs`,
      );
      return {
        packageName,
        packageVersion: dependency.packageVersion,
        path: tarballPath,
        sha256: dependency.tarballSha256,
        sizeBytes: bytes.byteLength,
      };
    })
    .toSorted((left, right) =>
      left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0,
    );
  assert(
    new Set(dependencyTarballs.map((entry) => entry.packageName)).size ===
      dependencyTarballs.length,
    `${label} dependency package names duplicate`,
  );
  assert(
    new Set(dependencyTarballs.map((entry) => entry.path)).size === dependencyTarballs.length,
    `${label} dependency tarball names duplicate`,
  );
  const declaredTarballPaths = [
    rootTarballPath,
    ...dependencyTarballs.map((entry) => entry.path),
  ].toSorted(compareStrings);
  const artifactTarballPaths = [...files.keys()]
    .filter((memberPath) => memberPath.endsWith(".tgz"))
    .toSorted(compareStrings);
  assert(
    canonicalJson(artifactTarballPaths) === canonicalJson(declaredTarballPaths),
    `${label} does not cover the exact artifact tarball set`,
  );
  assert(
    artifactPolicy.packageMembers.preflightManifest === artifactPolicy.binding.path,
    `${label} policy binding differs`,
  );
  return {
    version: 1,
    releaseTag: document.releaseTag,
    releaseSha: document.releaseSha,
    npmDistTag: document.npmDistTag,
    rootTarball: {
      packageName: document.packageName,
      packageVersion: document.packageVersion,
      path: rootTarballPath,
      sha256: document.tarballSha256,
      sizeBytes: rootTarballBytes.byteLength,
    },
    dependencyTarballs,
  };
}

function normalizeArtifact(value, artifactPolicy, gate, run, expectedSha, release) {
  exactObject(value, ["key", "metadata", "archiveBytes", "files"], [], `gate ${gate.id} artifact`);
  assert(value.key === artifactPolicy.key, `gate ${gate.id} artifact key differs from policy`);
  exactObject(
    value.metadata,
    ["id", "name", "digest", "sizeBytes", "runId", "workflowSha"],
    [],
    `gate ${gate.id} artifact metadata`,
  );
  const digestMatch = DIGEST_RE.exec(value.metadata.digest);
  assert(digestMatch, `gate ${gate.id} artifact digest is invalid`);
  assert(
    value.metadata.name === artifactPolicy.name,
    `gate ${gate.id} artifact name differs from policy`,
  );
  assert(value.metadata.runId === run.id, `gate ${gate.id} artifact run differs`);
  assert(
    value.metadata.workflowSha === run.headSha,
    `gate ${gate.id} artifact workflow SHA differs from run`,
  );
  assert(Buffer.isBuffer(value.archiveBytes), `gate ${gate.id} artifact archive must be bytes`);
  const sizeBytes = positiveInteger(value.metadata.sizeBytes, `gate ${gate.id} artifact size`);
  assert(
    value.archiveBytes.byteLength === sizeBytes,
    `gate ${gate.id} artifact archive size differs`,
  );
  assert(
    hashBytes(value.archiveBytes) === digestMatch[1],
    `gate ${gate.id} artifact digest differs`,
  );
  assert(value.files instanceof Map, `gate ${gate.id} artifact files must be a Map`);

  const members = [...value.files.entries()]
    .map(([memberPath, bytes]) => {
      validateRepositoryPath(memberPath, `gate ${gate.id} artifact member`);
      assert(Buffer.isBuffer(bytes), `gate ${gate.id} artifact member ${memberPath} must be bytes`);
      return { path: memberPath, sizeBytes: bytes.byteLength, sha256: hashBytes(bytes) };
    })
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  assert(members.length > 0, `gate ${gate.id} artifact is empty`);
  assert(
    new Set(members.map((member) => member.path)).size === members.length,
    `gate ${gate.id} artifact members duplicate`,
  );
  assert(
    canonicalJson(members.map((member) => member.path)) ===
      canonicalJson(artifactPolicy.requiredMembers),
    `gate ${gate.id} artifact inventory differs from policy`,
  );

  const bytes = value.files.get(artifactPolicy.binding.path);
  const decoded = decodeUtf8(bytes, `gate ${gate.id} binding member`);
  let document;
  try {
    document = JSON.parse(decoded);
  } catch {
    throw new Error(`gate ${gate.id} binding member is not valid JSON`);
  }
  const candidateSha = resolvePointer(
    document,
    artifactPolicy.binding.candidateShaPointer,
    `gate ${gate.id} candidate SHA binding`,
  );
  assert(
    candidateSha === expectedSha,
    `gate ${gate.id} artifact is bound to the wrong candidate SHA`,
  );
  const binding = {
    path: artifactPolicy.binding.path,
    candidateSha: {
      pointer: artifactPolicy.binding.candidateShaPointer,
      value: candidateSha,
    },
    sha256: hashBytes(bytes),
  };
  const packageManifest = artifactPolicy.packageMembers
    ? normalizeNpmPreflightManifest(
        document,
        artifactPolicy,
        value.files,
        expectedSha,
        release,
        gate,
      )
    : undefined;

  return {
    key: artifactPolicy.key,
    id: positiveInteger(value.metadata.id, `gate ${gate.id} artifact id`),
    name: value.metadata.name,
    digest: value.metadata.digest,
    sizeBytes,
    workflowSha: fullSha(value.metadata.workflowSha, `gate ${gate.id} artifact workflow SHA`),
    members,
    binding,
    ...(packageManifest ? { packageManifest } : {}),
  };
}

function normalizeSourceFrv(value, gate, run, delta, repository, artifacts) {
  assert(value && typeof value === "object", `gate ${gate.id} source FRV validation is missing`);
  assert(
    value.schema === "openclaw.release-validation-evidence/v3" && value.valid === true,
    `gate ${gate.id} source FRV validation is not strict v3 evidence`,
  );
  assert(value.repository === repository, `gate ${gate.id} source FRV repository differs`);
  assert(
    value.producerOnTrustedMainLineage === true &&
      value.directRoot === true &&
      value.evidenceReuse === null,
    `gate ${gate.id} source FRV is not a trusted direct root`,
  );
  assert(
    value.rerunGroup === "all" && value.releaseProfile === "full" && value.runReleaseSoak === true,
    `gate ${gate.id} source FRV coverage is not full`,
  );
  assert(
    canonicalJson(value.validationInputs) === canonicalJson(gate.validationInputs),
    `gate ${gate.id} source FRV validation inputs differ from policy`,
  );
  assert(
    value.controls?.performanceBlocking === true &&
      value.controls?.performanceReportPublication === "artifact-only",
    `gate ${gate.id} source FRV performance controls are not blocking`,
  );
  assert(
    value.conclusions?.current === "success" &&
      value.conclusions?.root === "success" &&
      value.conclusions?.allRequiredSucceeded === true,
    `gate ${gate.id} source FRV conclusions are not successful`,
  );
  assert(value.root?.runId === run.id, `gate ${gate.id} source FRV run differs`);
  assert(value.root?.runAttempt === run.runAttempt, `gate ${gate.id} source FRV attempt differs`);
  assert(value.root?.targetSha === delta.source.sha, `gate ${gate.id} source FRV target differs`);
  assert(value.root?.workflowSha === run.headSha, `gate ${gate.id} source FRV workflow differs`);
  assert(
    value.root?.status === "completed" && value.root?.conclusion === "success",
    `gate ${gate.id} source FRV root is not successful`,
  );
  const artifact = value.root?.artifact;
  const digestMatch = DIGEST_RE.exec(artifact?.digest ?? "");
  assert(digestMatch, `gate ${gate.id} source FRV artifact digest is invalid`);
  const normalizedArtifact = artifacts.find((entry) => entry.id === Number(artifact.id));
  assert(
    normalizedArtifact &&
      normalizedArtifact.name === artifact.name &&
      normalizedArtifact.digest === artifact.digest &&
      normalizedArtifact.sizeBytes === artifact.sizeInBytes,
    `gate ${gate.id} source FRV artifact differs from the strict validator`,
  );
  return {
    schema: value.schema,
    sha256: canonicalJsonSha256(value),
    releaseProfile: value.releaseProfile,
    runReleaseSoak: value.runReleaseSoak,
    validationInputs: gate.validationInputs,
    runId: run.id,
    targetSha: delta.source.sha,
    artifact: {
      id: positiveInteger(Number(artifact.id), `gate ${gate.id} source FRV artifact id`),
      name: nonEmptyString(artifact.name, `gate ${gate.id} source FRV artifact name`),
      digest: artifact.digest,
      sizeBytes: positiveInteger(artifact.sizeInBytes, `gate ${gate.id} source FRV artifact size`),
    },
    conclusion: "success",
  };
}

function normalizeGateEvidence(gate, plan, value, delta, repository, release) {
  exactObject(
    value,
    ["id", "run", "job", "artifacts"],
    ["sourceValidation"],
    `gate ${gate.id} evidence`,
  );
  assert(value.id === gate.id, `gate ${gate.id} evidence id differs`);
  const run = normalizeRun(value.run, gate, repository, delta);
  const job = normalizeJob(value.job, gate, run);
  assert(Array.isArray(value.artifacts), `gate ${gate.id} artifacts must be an array`);
  assert(
    value.artifacts.length === gate.artifacts.length,
    `gate ${gate.id} artifact count differs`,
  );
  const artifactsByKey = new Map(value.artifacts.map((artifact) => [artifact.key, artifact]));
  assert(artifactsByKey.size === value.artifacts.length, `gate ${gate.id} artifact keys duplicate`);
  const expectedSha = plan.mode === "fresh" ? delta.target.sha : delta.source.sha;
  const artifacts = gate.artifacts.map((artifactPolicy) =>
    normalizeArtifact(
      artifactsByKey.get(artifactPolicy.key),
      artifactPolicy,
      gate,
      run,
      expectedSha,
      release,
    ),
  );
  const candidateBound = artifacts.every(
    (artifact) => artifact.binding.candidateSha.value === expectedSha,
  );
  assert(candidateBound, `gate ${gate.id} evidence does not bind the ${plan.mode} candidate SHA`);
  const sourceValidation =
    gate.kind === "source-frv"
      ? normalizeSourceFrv(value.sourceValidation, gate, run, delta, repository, artifacts)
      : undefined;
  assert(
    gate.kind === "source-frv" || value.sourceValidation === undefined,
    `gate ${gate.id} must not include source FRV validation`,
  );
  return {
    id: gate.id,
    mode: plan.mode,
    impactedPaths: plan.impactedPaths,
    rationale: plan.reason,
    run,
    job,
    artifacts,
    ...(sourceValidation ? { sourceValidation } : {}),
    conclusion: "success",
  };
}

function packageEvidenceForGate(policyGate, manifestGate) {
  const artifactPolicy = policyGate.artifacts.find((artifact) => artifact.packageMembers);
  const artifact = manifestGate.artifacts.find((entry) => entry.key === artifactPolicy.key);
  assert(artifact.packageManifest, `gate ${manifestGate.id} package manifest is missing`);
  return {
    gateId: manifestGate.id,
    mode: manifestGate.mode,
    artifact: {
      id: artifact.id,
      name: artifact.name,
      digest: artifact.digest,
    },
    releaseTag: artifact.packageManifest.releaseTag,
    releaseSha: artifact.packageManifest.releaseSha,
    npmDistTag: artifact.packageManifest.npmDistTag,
    rootTarball: artifact.packageManifest.rootTarball,
    dependencyTarballs: artifact.packageManifest.dependencyTarballs,
  };
}

function buildPackageEvidence(policy, gates) {
  const gateById = new Map(gates.map((gate) => [gate.id, gate]));
  const sourcePolicy = policy.gates.find((gate) => gate.kind === "source-npm");
  const targetPolicy = policy.gates.find((gate) => gate.kind === "root-package");
  const source = packageEvidenceForGate(sourcePolicy, gateById.get(sourcePolicy.id));
  const target = packageEvidenceForGate(targetPolicy, gateById.get(targetPolicy.id));
  assert(source.mode === "reuse", "source npm package gate must reuse source evidence");
  assert(target.mode === "fresh", "target root package gate must use fresh evidence");
  assert(
    source.releaseTag === target.releaseTag && source.npmDistTag === target.npmDistTag,
    "source and target npm release selectors differ",
  );
  assert(
    source.releaseSha !== target.releaseSha,
    "source and target npm evidence SHAs must differ",
  );
  assert(
    source.rootTarball.packageName === target.rootTarball.packageName &&
      source.rootTarball.packageVersion === target.rootTarball.packageVersion &&
      source.rootTarball.path === target.rootTarball.path,
    "source and target root tarball identities differ",
  );
  assert(
    source.dependencyTarballs.length === target.dependencyTarballs.length,
    "source and target dependency tarball counts differ",
  );
  const dependencyTarballs = source.dependencyTarballs.map((sourceMember, index) => {
    const targetMember = target.dependencyTarballs[index];
    assert(
      sourceMember.packageName === targetMember.packageName &&
        sourceMember.packageVersion === targetMember.packageVersion &&
        sourceMember.path === targetMember.path &&
        sourceMember.sha256 === targetMember.sha256 &&
        sourceMember.sizeBytes === targetMember.sizeBytes,
      `dependency tarball differs across the changelog delta: ${sourceMember.packageName}`,
    );
    return {
      packageName: sourceMember.packageName,
      packageVersion: sourceMember.packageVersion,
      path: sourceMember.path,
      sha256: sourceMember.sha256,
      sizeBytes: sourceMember.sizeBytes,
    };
  });
  return {
    releaseTag: source.releaseTag,
    npmDistTag: source.npmDistTag,
    sourceReleaseSha: source.releaseSha,
    targetReleaseSha: target.releaseSha,
    sourceGate: source.gateId,
    targetGate: target.gateId,
    sourceArtifact: source.artifact,
    targetArtifact: target.artifact,
    sourceRootTarball: source.rootTarball,
    targetRootTarball: target.rootTarball,
    rawRootTarballEqual:
      source.rootTarball.sha256 === target.rootTarball.sha256 &&
      source.rootTarball.sizeBytes === target.rootTarball.sizeBytes,
    dependencyTarballs,
  };
}

function normalizeProducer(value, workflowSha, targetSha) {
  exactObject(
    value,
    ["workflowPath", "workflowSha", "workflowRef", "runId", "runAttempt", "artifactName"],
    [],
    "producer",
  );
  assert(
    value.workflowPath === ".github/workflows/release-delta-evidence.yml",
    "producer workflow path is invalid",
  );
  assert(value.workflowSha === workflowSha, "producer workflow SHA differs");
  assert(value.workflowRef === "refs/heads/main", "producer workflow ref must be main");
  assert(value.runAttempt === 1, "producer must be workflow run attempt 1");
  const runId = positiveInteger(value.runId, "producer run id");
  assert(
    value.artifactName === `release-delta-evidence-${targetSha}-${runId}-1`,
    "producer artifact name differs",
  );
  return {
    workflowPath: value.workflowPath,
    workflowSha: fullSha(value.workflowSha, "producer workflow SHA"),
    workflowRef: value.workflowRef,
    runId,
    runAttempt: 1,
    artifactName: value.artifactName,
  };
}

function validateGateWorkflowTrust(cwd, policy, delta, producerWorkflowSha) {
  assert(
    gitSucceeds(cwd, ["cat-file", "-e", `${producerWorkflowSha}^{commit}`]),
    "producer workflow commit is unavailable",
  );
  for (const gate of policy.gates) {
    assert(
      gitSucceeds(cwd, ["cat-file", "-e", `${gate.workflowSha}^{commit}`]),
      `gate ${gate.id} workflow commit is unavailable`,
    );
    assert(
      gitSucceeds(cwd, ["cat-file", "-e", `${gate.workflowSha}:${gate.workflowPath}`]),
      `gate ${gate.id} workflow file is unavailable at its workflow SHA`,
    );
    if (gate.kind === "source-npm") {
      assert(
        gate.workflowSha === delta.source.sha,
        `gate ${gate.id} must execute from the source release candidate`,
      );
      continue;
    }
    if (gate.kind === "root-package") {
      assert(
        gate.workflowSha === delta.target.sha,
        `gate ${gate.id} must execute from the target release candidate`,
      );
      continue;
    }
    assert(
      gitSucceeds(cwd, ["merge-base", "--is-ancestor", gate.workflowSha, producerWorkflowSha]),
      `gate ${gate.id} workflow SHA is not on trusted main lineage`,
    );
  }
}

export function createReleaseDeltaManifest(options) {
  const policy = parseReleaseDeltaPolicy(options.policy);
  const repository = nonEmptyString(options.repository, "repository");
  validateReleaseDeltaPolicyPath(options.policyPath);
  const policyBytes = Buffer.isBuffer(options.policyBytes)
    ? options.policyBytes
    : Buffer.from(options.policyBytes);
  assert(
    canonicalJson(parseReleaseDeltaPolicy(policyBytes)) === canonicalJson(policy),
    "policy input differs from the trusted policy bytes",
  );
  const policyBlobBytes = git(
    options.cwd,
    ["show", `${fullSha(options.workflowSha, "workflow SHA")}:${options.policyPath}`],
    "buffer",
  );
  assert(
    policyBlobBytes.equals(policyBytes),
    "policy bytes differ from the trusted workflow commit",
  );
  const policyBlobSha = fullSha(
    git(options.cwd, ["rev-parse", `${options.workflowSha}:${options.policyPath}`]).trim(),
    "policy blob SHA",
  );
  const delta = computeReleaseDelta(options.cwd, policy, options.targetSha, options.branchTipSha);
  const producer = normalizeProducer(options.producer, options.workflowSha, delta.target.sha);
  validateGateWorkflowTrust(options.cwd, policy, delta, producer.workflowSha);
  const verificationBySha = new Map(
    options.commitVerifications.map((entry) => [entry.sha, entry.verification]),
  );
  assert(
    verificationBySha.size === options.commitVerifications.length,
    "commit verifications duplicate",
  );
  const commits = delta.commits.map((commit) => ({
    ...commit,
    verification: normalizeCommitVerification(verificationBySha.get(commit.sha), commit.sha),
  }));
  assert(Array.isArray(options.evidence), "evidence must be an array");
  const evidenceById = new Map(options.evidence.map((entry) => [entry.id, entry]));
  assert(evidenceById.size === options.evidence.length, "evidence gate ids duplicate");
  const planById = new Map(delta.gates.map((entry) => [entry.id, entry]));
  const gates = policy.gates.map((gate) =>
    normalizeGateEvidence(
      gate,
      planById.get(gate.id),
      evidenceById.get(gate.id),
      delta,
      repository,
      policy.release,
    ),
  );
  assert(evidenceById.size === gates.length, "evidence includes unknown gates");

  const reused = gates.filter((gate) => gate.mode === "reuse").map((gate) => gate.id);
  const fresh = gates.filter((gate) => gate.mode === "fresh").map((gate) => gate.id);
  return {
    schema: RELEASE_DELTA_MANIFEST_SCHEMA,
    mode: "changelog-only-v1",
    repository,
    release: policy.release,
    producer,
    policy: {
      path: options.policyPath,
      blobSha: policyBlobSha,
      sha256: hashBytes(policyBytes),
      schema: policy.schema,
    },
    workflowSha: fullSha(options.workflowSha, "workflow SHA"),
    source: delta.source,
    target: delta.target,
    commits,
    changedPaths: delta.changedPaths,
    diffSha256: delta.diffSha256,
    metadataPaths: delta.metadataPaths,
    gates,
    packageEvidence: buildPackageEvidence(policy, gates),
    coverage: {
      reused,
      fresh,
      changedPathCount: delta.changedPaths.length,
      gateCount: gates.length,
    },
    conclusion: "success",
    rationale:
      reused.length > 0
        ? `Reused ${reused.length} unaffected gate(s); ran ${fresh.length} exact-target gate(s).`
        : `All ${fresh.length} gate(s) require exact-target evidence.`,
    publicationPerformed: false,
  };
}

export function validateReleaseDeltaManifest(manifest, options) {
  assert(manifest?.schema === RELEASE_DELTA_MANIFEST_SCHEMA, "manifest schema is invalid");
  assert(manifest.publicationPerformed === false, "delta evidence must not authorize publication");
  const expected = createReleaseDeltaManifest(options);
  assert(
    canonicalJson(manifest) === canonicalJson(expected),
    "manifest differs from current evidence",
  );
  return {
    valid: true,
    manifestSha256: canonicalJsonSha256(manifest),
    sourceSha: manifest.source.sha,
    targetSha: manifest.target.sha,
    conclusion: manifest.conclusion,
    publicationPerformed: false,
  };
}

export function readReleaseDeltaPolicy(policyPath) {
  validateReleaseDeltaPolicyPath(policyPath);
  const bytes = readFileSync(policyPath);
  return { bytes, policy: parseReleaseDeltaPolicy(bytes) };
}

export function evidenceBindingsFromManifest(manifest) {
  assert(manifest?.schema === RELEASE_DELTA_MANIFEST_SCHEMA, "manifest schema is invalid");
  return Object.fromEntries(
    manifest.gates.map((gate) => [
      gate.id,
      {
        runId: gate.run.id,
        runAttempt: gate.run.runAttempt,
        jobId: gate.job.id,
        artifacts: Object.fromEntries(
          gate.artifacts.map((artifact) => [artifact.key, artifact.id]),
        ),
      },
    ]),
  );
}
