#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { canonicalJson } from "./lib/canonical-json.mjs";
import { execPlainGh } from "./lib/plain-gh.mjs";
import {
  computeReleaseDelta,
  createReleaseDeltaManifest,
  evidenceBindingsFromManifest,
  parseReleaseDeltaPolicy,
  validateReleaseDeltaManifest,
} from "./lib/release-delta-evidence.mjs";

const MAX_ARTIFACT_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ARTIFACT_MEMBER_BYTES = 256 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

function firstRunAttempt(value, label) {
  const runAttempt = positiveInteger(value, label);
  if (runAttempt !== 1) {
    fail(`${label} must be 1`);
  }
  return runAttempt;
}

function isErrorWithCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseOptions(argv) {
  const command = argv.shift();
  if (!["create", "verify"].includes(command)) {
    fail("expected create or verify");
  }
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      policy: { type: "string" },
      "target-sha": { type: "string" },
      "workflow-sha": { type: "string" },
      "producer-run-id": { type: "string" },
      "producer-run-attempt": { type: "string" },
      "producer-workflow-path": { type: "string" },
      "producer-workflow-ref": { type: "string" },
      "producer-artifact-name": { type: "string" },
      "evidence-runs": { type: "string" },
      manifest: { type: "string" },
      output: { type: "string" },
      "github-output": { type: "string" },
    },
    strict: true,
  });
  for (const key of [
    "repo",
    "policy",
    "target-sha",
    "workflow-sha",
    "producer-run-id",
    "producer-run-attempt",
    "producer-workflow-path",
    "producer-workflow-ref",
    "producer-artifact-name",
  ]) {
    if (!values[key]) {
      fail(`--${key} is required`);
    }
  }
  if (command === "create" && (!values["evidence-runs"] || !values.output)) {
    fail("create requires --evidence-runs and --output");
  }
  if (command === "verify" && !values.manifest) {
    fail("verify requires --manifest");
  }
  return {
    command,
    repo: values.repo,
    policyPath: values.policy,
    targetSha: values["target-sha"],
    workflowSha: values["workflow-sha"],
    producer: {
      workflowPath: values["producer-workflow-path"],
      workflowSha: values["workflow-sha"],
      workflowRef: values["producer-workflow-ref"],
      runId: positiveInteger(values["producer-run-id"], "producer run id"),
      runAttempt: positiveInteger(values["producer-run-attempt"], "producer run attempt"),
      artifactName: values["producer-artifact-name"],
    },
    evidenceRunsPath: values["evidence-runs"],
    manifestPath: values.manifest,
    outputPath: values.output,
    githubOutputPath: values["github-output"],
  };
}

function githubApi(apiPath) {
  return JSON.parse(
    execPlainGh(["api", apiPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
}

function branchTipSha(repo, targetRef, api) {
  const ref = api(`repos/${repo}/git/ref/heads/${targetRef}`);
  if (ref?.object?.type !== "commit" || typeof ref.object.sha !== "string") {
    fail(`target branch ref is invalid: ${targetRef}`);
  }
  return ref.object.sha;
}

function commitVerifications(repo, delta, api) {
  return delta.commits.map((commit) => {
    const response = api(`repos/${repo}/commits/${commit.sha}`);
    if (response?.sha !== commit.sha) {
      fail(`commit API identity differs for ${commit.sha}`);
    }
    const verification = response?.commit?.verification;
    return {
      sha: commit.sha,
      verification: {
        verified: verification?.verified,
        reason: verification?.reason,
        verifiedAt: verification?.verified_at,
      },
    };
  });
}

function exactKeys(value, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const expected = required.toSorted();
  const actual = Object.keys(value).toSorted();
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    fail(`${label} keys must be exactly: ${expected.join(", ")}`);
  }
}

function parseEvidenceBindings(input, policy) {
  const value = typeof input === "string" || Buffer.isBuffer(input) ? JSON.parse(input) : input;
  exactKeys(
    value,
    policy.gates.map((gate) => gate.id),
    "evidence runs",
  );
  return Object.fromEntries(
    policy.gates.map((gate) => {
      const binding = value[gate.id];
      exactKeys(binding, ["runId", "runAttempt", "jobId", "artifacts"], `evidence runs.${gate.id}`);
      exactKeys(
        binding.artifacts,
        gate.artifacts.map((artifact) => artifact.key),
        `evidence runs.${gate.id}.artifacts`,
      );
      return [
        gate.id,
        {
          runId: positiveInteger(binding.runId, `${gate.id} run id`),
          runAttempt: firstRunAttempt(binding.runAttempt, `${gate.id} run attempt`),
          jobId: positiveInteger(binding.jobId, `${gate.id} job id`),
          artifacts: Object.fromEntries(
            gate.artifacts.map((artifact) => [
              artifact.key,
              positiveInteger(
                binding.artifacts[artifact.key],
                `${gate.id} ${artifact.key} artifact id`,
              ),
            ]),
          ),
        },
      ];
    }),
  );
}

function normalizeRun(response) {
  return {
    id: response.id,
    runAttempt: response.run_attempt,
    name: response.name,
    path: response.path,
    event: response.event,
    headBranch: response.head_branch,
    headRepository: response.head_repository?.full_name,
    headSha: response.head_sha,
    url: response.html_url,
    status: response.status,
    conclusion: response.conclusion,
  };
}

function normalizeJob(response) {
  return {
    id: response.id,
    runId: response.run_id,
    runAttempt: response.run_attempt,
    name: response.name,
    headSha: response.head_sha,
    url: response.html_url,
    status: response.status,
    conclusion: response.conclusion,
  };
}

function normalizeArtifactMetadata(response) {
  if (response.expired !== false) {
    fail("Actions artifact is expired");
  }
  return {
    id: response.id,
    name: response.name,
    digest: response.digest,
    sizeBytes: response.size_in_bytes,
    runId: response.workflow_run?.id,
    workflowSha: response.workflow_run?.head_sha,
  };
}

function validateSourceFrv({ cwd, repo, runId }) {
  const script = path.join(
    cwd,
    ".agents/skills/release-openclaw-ci/scripts/release-ci-summary.mjs",
  );
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        script,
        "--validate-run",
        String(runId),
        "--repo",
        repo,
        "--trusted-workflow-ref",
        "main",
        "--json",
      ],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      },
    ),
  );
}

async function loadProductionArtifactReader() {
  try {
    const module = await import("./lib/actions-artifact-archive.mjs");
    if (typeof module.readPublicationArtifactArchive === "function") {
      return module.readPublicationArtifactArchive;
    }
  } catch (/** @type {unknown} */ error) {
    if (!isErrorWithCode(error, "ERR_MODULE_NOT_FOUND")) {
      throw error;
    }
  }
  throw new Error(
    "release delta artifact adapter is pending scripts/lib/actions-artifact-archive.mjs from #103809",
  );
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

async function collectGateEvidence({
  cwd,
  repo,
  policy,
  delta,
  bindings,
  api,
  artifactReader,
  token,
  sourceFrvValidator,
}) {
  const readArtifact = artifactReader ?? (await loadProductionArtifactReader());
  if (typeof token !== "string" || token.trim() === "") {
    fail("GH_TOKEN is required to read immutable Actions artifacts");
  }
  const evidence = [];
  for (const gate of policy.gates) {
    const binding = bindings[gate.id];
    const runResponse = await api(`repos/${repo}/actions/runs/${binding.runId}`);
    if (runResponse.run_attempt !== binding.runAttempt) {
      fail(`gate ${gate.id} run attempt differs from the requested tuple`);
    }
    const jobResponse = await api(`repos/${repo}/actions/jobs/${binding.jobId}`);
    const run = normalizeRun(runResponse);
    const job = normalizeJob(jobResponse);
    const artifacts = [];
    for (const artifactPolicy of gate.artifacts) {
      const runExpectation = gateRunExpectation(gate, delta);
      const artifactId = binding.artifacts[artifactPolicy.key];
      const artifactResponse = await api(`repos/${repo}/actions/artifacts/${artifactId}`);
      const metadata = normalizeArtifactMetadata(artifactResponse);
      const expected = {
        repository: repo,
        artifactId,
        artifactName: artifactPolicy.name,
        artifactDigest: artifactResponse.digest,
        artifactSizeBytes: artifactResponse.size_in_bytes,
        runId: binding.runId,
        runAttempt: binding.runAttempt,
        workflowSha: runExpectation.headSha,
        workflowPath: gate.workflowPath,
        workflowEvent: "workflow_dispatch",
        workflowHeadBranch: runExpectation.headBranch,
        runStatePolicy: "completed-success",
      };
      const archive = await readArtifact({
        token,
        expected,
        maxArchiveBytes: MAX_ARTIFACT_ARCHIVE_BYTES,
        archivePolicy: {
          expectedEntries: artifactPolicy.requiredMembers,
          maxArchiveBytes: MAX_ARTIFACT_ARCHIVE_BYTES,
          maxExpandedBytes: MAX_ARTIFACT_EXPANDED_BYTES,
          maxCompressedEntryBytes: () => MAX_ARTIFACT_MEMBER_BYTES,
          maxEntryBytes: () => MAX_ARTIFACT_MEMBER_BYTES,
        },
      });
      if (
        !Buffer.isBuffer(archive?.archiveBytes) ||
        !(archive.files instanceof Map) ||
        canonicalJson(archive.binding) !==
          canonicalJson({
            ...expected,
            workflowStatus: "completed",
            workflowConclusion: "success",
          }) ||
        archive.artifactMetadata?.id !== artifactId ||
        archive.artifactMetadata?.name !== artifactPolicy.name ||
        archive.artifactMetadata?.digest !== artifactResponse.digest ||
        archive.artifactMetadata?.size_in_bytes !== artifactResponse.size_in_bytes ||
        archive.workflowRun?.id !== binding.runId ||
        archive.workflowRun?.run_attempt !== binding.runAttempt
      ) {
        fail(`artifact reader returned invalid evidence for ${gate.id}/${artifactPolicy.key}`);
      }
      artifacts.push({
        key: artifactPolicy.key,
        metadata,
        archiveBytes: archive.archiveBytes,
        files: archive.files,
      });
    }
    evidence.push({
      id: gate.id,
      run,
      job,
      artifacts,
      ...(gate.kind === "source-frv"
        ? {
            sourceValidation: await (sourceFrvValidator ?? validateSourceFrv)({
              cwd,
              repo,
              runId: binding.runId,
            }),
          }
        : {}),
    });
  }
  return evidence;
}

async function assembleInputs(options, overrides, bindings) {
  const api = overrides.api ?? githubApi;
  const cwd = overrides.cwd ?? process.cwd();
  const policyBytes = readFileSync(path.resolve(cwd, options.policyPath));
  const policy = parseReleaseDeltaPolicy(policyBytes);
  const tipSha = branchTipSha(options.repo, policy.targetRef, api);
  const delta = computeReleaseDelta(cwd, policy, options.targetSha, tipSha);
  const verifications = commitVerifications(options.repo, delta, api);
  const evidence = await collectGateEvidence({
    cwd,
    repo: options.repo,
    policy,
    delta,
    bindings,
    api,
    artifactReader: overrides.artifactReader,
    token: overrides.token ?? process.env.GH_TOKEN,
    sourceFrvValidator: overrides.sourceFrvValidator,
  });
  return {
    cwd,
    repository: options.repo,
    policy,
    policyBytes,
    policyPath: options.policyPath,
    workflowSha: options.workflowSha,
    producer: options.producer,
    targetSha: options.targetSha,
    branchTipSha: tipSha,
    commitVerifications: verifications,
    evidence,
  };
}

function writeGithubOutput(filePath, result) {
  if (!filePath) {
    return;
  }
  writeFileSync(
    filePath,
    [
      `manifest_sha256=${result.manifestSha256}`,
      `source_sha=${result.sourceSha}`,
      `target_sha=${result.targetSha}`,
      `conclusion=${result.conclusion}`,
      "publication_performed=false",
      "",
    ].join("\n"),
    { flag: "a" },
  );
}

export async function runReleaseDeltaEvidence(argv, overrides = {}) {
  const options = parseOptions([...argv]);
  const cwd = overrides.cwd ?? process.cwd();
  const policy = parseReleaseDeltaPolicy(readFileSync(path.resolve(cwd, options.policyPath)));
  if (options.command === "create") {
    const bindings = parseEvidenceBindings(readFileSync(options.evidenceRunsPath), policy);
    const inputs = await assembleInputs(options, overrides, bindings);
    const manifest = createReleaseDeltaManifest(inputs);
    writeFileSync(options.outputPath, canonicalJson(manifest));
    const result = validateReleaseDeltaManifest(manifest, inputs);
    writeGithubOutput(options.githubOutputPath, result);
    return result;
  }

  const manifest = JSON.parse(readFileSync(options.manifestPath, "utf8"));
  const bindings = parseEvidenceBindings(evidenceBindingsFromManifest(manifest), policy);
  const inputs = await assembleInputs(options, overrides, bindings);
  const result = validateReleaseDeltaManifest(manifest, inputs);
  writeGithubOutput(options.githubOutputPath, result);
  return result;
}

export async function main(argv = process.argv.slice(2), overrides = {}) {
  const result = await runReleaseDeltaEvidence(argv, overrides);
  process.stdout.write(`${canonicalJson(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((/** @type {unknown} */ error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
