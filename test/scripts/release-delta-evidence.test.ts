import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { canonicalJson } from "../../scripts/lib/canonical-json.mjs";
import {
  computeReleaseDelta,
  createReleaseDeltaManifest,
  parseReleaseDeltaPolicy,
  validateReleaseDeltaManifest,
} from "../../scripts/lib/release-delta-evidence.mjs";
import { runReleaseDeltaEvidence } from "../../scripts/release-delta-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const POLICY_PATH = ".github/release-delta-policies/test.json";
const REPOSITORY = "openclaw/openclaw";
const VERSION = "2026.7.1-beta.3";
const TARGET_REF = "release/2026.7.1";
const VALIDATION_INPUTS = {
  provider: "openai",
  mode: "both",
  liveSuiteFilter: "",
  crossOsSuiteFilter: "",
  releasePackageSpec: "",
  packageAcceptancePackageSpec: "",
  codexPluginSpec: "",
};
const roots = useAutoCleanupTempDirTracker(afterEach);

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

type WorkflowStep = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type Workflow = {
  jobs: {
    produce: {
      steps: WorkflowStep[];
    };
  };
};

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root: string, filePath: string, value: string | Buffer) {
  const destination = path.join(root, filePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, value);
}

type GateFixture = {
  id: string;
  kind: "generic" | "source-frv" | "source-npm" | "root-package";
  reuse: "never" | "when-unimpacted";
  workflowPath: string;
  workflowSha: string;
  jobName: string;
  impactPaths: string[];
  validationInputs?: typeof VALIDATION_INPUTS;
  artifacts: Array<{
    key: string;
    name: string;
    requiredMembers: string[];
    binding: { path: string; candidateShaPointer: string };
    packageMembers?: { preflightManifest: string };
  }>;
};

function gate(
  id: string,
  kind: GateFixture["kind"],
  workflowSha: string,
  overrides: Partial<GateFixture> = {},
): GateFixture {
  return {
    id,
    kind,
    reuse: "when-unimpacted",
    workflowPath: `.github/workflows/${id}.yml`,
    workflowSha,
    jobName: `${id} proof`,
    impactPaths: ["src/**"],
    artifacts: [
      {
        key: "evidence",
        name: `${id}-evidence`,
        requiredMembers: ["binding.json"],
        binding: { path: "binding.json", candidateShaPointer: "/targetSha" },
      },
    ],
    ...overrides,
  };
}

function packageGate(
  id: string,
  kind: "source-npm" | "root-package",
  workflowSha: string,
): GateFixture {
  return gate(id, kind, workflowSha, {
    artifacts: [
      {
        key: "package",
        name: `${id}-package`,
        requiredMembers: ["openclaw.tgz", "openclaw-ai.tgz", "preflight-manifest.json"],
        binding: {
          path: "preflight-manifest.json",
          candidateShaPointer: "/releaseSha",
        },
        packageMembers: {
          preflightManifest: "preflight-manifest.json",
        },
      },
    ],
  });
}

function createFixture() {
  const root = roots.make("openclaw-release-delta-");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["config", "user.email", "release@example.com"]);
  write(root, "src/index.ts", "export const value = 1;\n");
  write(root, "package.json", `${JSON.stringify({ name: "openclaw", version: VERSION })}\n`);
  write(root, "CHANGELOG.md", "# Changelog\n\n## 2026.7.1\n\n- source\n");
  for (const workflow of [
    "full-release-validation.yml",
    "source-npm.yml",
    "target-npm.yml",
    "release-notes.yml",
  ]) {
    write(root, `.github/workflows/${workflow}`, `name: ${workflow}\n`);
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "test: source"]);
  const sourceSha = git(root, ["rev-parse", "HEAD"]);
  const evidenceWorkflowSha = sourceSha;

  git(root, ["switch", "-c", TARGET_REF]);
  write(root, "CHANGELOG.md", "# Changelog\n\n## 2026.7.1\n\n- target\n");
  git(root, ["add", "CHANGELOG.md"]);
  git(root, ["commit", "-m", "docs: finalize release notes"]);
  const targetSha = git(root, ["rev-parse", "HEAD"]);

  git(root, ["switch", "main"]);
  const gates = [
    gate("source-frv", "source-frv", evidenceWorkflowSha, {
      workflowPath: ".github/workflows/full-release-validation.yml",
      jobName: "Verify full validation",
      validationInputs: VALIDATION_INPUTS,
    }),
    packageGate("source-npm", "source-npm", evidenceWorkflowSha),
    packageGate("target-npm", "root-package", targetSha),
    gate("release-notes", "generic", evidenceWorkflowSha, {
      reuse: "never",
      impactPaths: [],
    }),
  ];
  const policy = {
    schema: "openclaw.release-delta-policy/v1",
    release: { version: VERSION, channel: "beta" },
    targetRef: TARGET_REF,
    sourceSha,
    allowedPaths: ["CHANGELOG.md"],
    metadataPaths: ["CHANGELOG.md"],
    gates,
  };
  write(root, POLICY_PATH, `${canonicalJson(policy)}\n`);
  git(root, ["add", POLICY_PATH]);
  git(root, ["commit", "-m", "ci: add delta policy"]);
  const workflowSha = git(root, ["rev-parse", "HEAD"]);

  return {
    root,
    sourceSha,
    targetSha,
    evidenceWorkflowSha,
    workflowSha,
    policy,
    gates,
  };
}

function archive(
  id: number,
  name: string,
  runId: number,
  workflowSha: string,
  files: Map<string, Buffer>,
) {
  const archiveBytes = Buffer.from(`artifact-${id}-${name}`);
  return {
    key: "",
    metadata: {
      id,
      name,
      digest: `sha256:${sha256(archiveBytes)}`,
      sizeBytes: archiveBytes.byteLength,
      runId,
      workflowSha,
    },
    archiveBytes,
    files,
  };
}

function evidenceFixture(fixture: ReturnType<typeof createFixture>) {
  let nextId = 100;
  const evidence = fixture.gates.map((gateFixture) => {
    const runId = nextId++;
    const jobId = nextId++;
    const candidateSha =
      gateFixture.kind === "source-frv" || gateFixture.kind === "source-npm"
        ? fixture.sourceSha
        : fixture.targetSha;
    const releaseCandidateRun =
      gateFixture.kind === "source-npm" || gateFixture.kind === "root-package";
    const runHeadSha = releaseCandidateRun ? candidateSha : fixture.evidenceWorkflowSha;
    const runHeadBranch = releaseCandidateRun ? TARGET_REF : "main";
    const artifacts = gateFixture.artifacts.map((artifactPolicy) => {
      const files = new Map<string, Buffer>();
      if (artifactPolicy.packageMembers) {
        const rootBytes = Buffer.from(
          gateFixture.kind === "source-npm" ? "source-root" : "target-root",
        );
        const dependencyBytes = Buffer.from("identical-dependency");
        files.set("openclaw.tgz", rootBytes);
        files.set("openclaw-ai.tgz", dependencyBytes);
        files.set(
          "preflight-manifest.json",
          Buffer.from(
            JSON.stringify({
              version: 1,
              releaseTag: `v${VERSION}`,
              releaseSha: candidateSha,
              npmDistTag: "beta",
              packageName: "openclaw",
              packageVersion: VERSION,
              tarballName: "openclaw.tgz",
              tarballSha256: sha256(rootBytes),
              dependencyTarballs: [
                {
                  packageName: "@openclaw/ai",
                  packageVersion: VERSION,
                  tarballName: "openclaw-ai.tgz",
                  tarballSha256: sha256(dependencyBytes),
                },
              ],
              dependencyEvidenceDir: "dependency-evidence",
              dependencyEvidenceManifest: "dependency-evidence/dependency-evidence-manifest.json",
            }),
          ),
        );
      } else {
        files.set("binding.json", Buffer.from(JSON.stringify({ targetSha: candidateSha })));
      }
      const value = archive(nextId++, artifactPolicy.name, runId, runHeadSha, files);
      value.key = artifactPolicy.key;
      return value;
    });
    const run = {
      id: runId,
      runAttempt: 1,
      name: gateFixture.id,
      path: gateFixture.workflowPath,
      event: "workflow_dispatch",
      headBranch: runHeadBranch,
      headRepository: REPOSITORY,
      headSha: runHeadSha,
      url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
      status: "completed",
      conclusion: "success",
    };
    const job = {
      id: jobId,
      runId,
      runAttempt: 1,
      name: gateFixture.jobName,
      headSha: runHeadSha,
      url: `https://github.com/${REPOSITORY}/actions/runs/${runId}/job/${jobId}`,
      status: "completed",
      conclusion: "success",
    };
    return {
      id: gateFixture.id,
      run,
      job,
      artifacts,
      ...(gateFixture.kind === "source-frv"
        ? {
            sourceValidation: {
              schema: "openclaw.release-validation-evidence/v3",
              valid: true,
              repository: REPOSITORY,
              producerOnTrustedMainLineage: true,
              directRoot: true,
              evidenceReuse: null,
              rerunGroup: "all",
              releaseProfile: "full",
              runReleaseSoak: true,
              validationInputs: VALIDATION_INPUTS,
              controls: {
                performanceBlocking: true,
                performanceReportPublication: "artifact-only",
              },
              conclusions: {
                current: "success",
                root: "success",
                allRequiredSucceeded: true,
              },
              root: {
                runId,
                runAttempt: 1,
                targetSha: fixture.sourceSha,
                workflowSha: fixture.evidenceWorkflowSha,
                status: "completed",
                conclusion: "success",
                artifact: {
                  id: String(artifacts[0].metadata.id),
                  name: artifacts[0].metadata.name,
                  digest: artifacts[0].metadata.digest,
                  sizeInBytes: artifacts[0].metadata.sizeBytes,
                },
              },
            },
          }
        : {}),
    };
  });
  return evidence;
}

function rewritePreflightManifest(
  artifact: ReturnType<typeof evidenceFixture>[number]["artifacts"][number],
  update: (manifest: any) => void,
) {
  const manifest = JSON.parse(artifact.files.get("preflight-manifest.json")!.toString("utf8"));
  update(manifest);
  artifact.files.set("preflight-manifest.json", Buffer.from(JSON.stringify(manifest)));
}

function manifestInputs(
  fixture: ReturnType<typeof createFixture>,
  evidence = evidenceFixture(fixture),
) {
  return {
    cwd: fixture.root,
    repository: REPOSITORY,
    policy: fixture.policy,
    policyBytes: readFileSync(path.join(fixture.root, POLICY_PATH)),
    policyPath: POLICY_PATH,
    workflowSha: fixture.workflowSha,
    producer: {
      workflowPath: ".github/workflows/release-delta-evidence.yml",
      workflowSha: fixture.workflowSha,
      workflowRef: "refs/heads/main",
      runId: 999,
      runAttempt: 1,
      artifactName: `release-delta-evidence-${fixture.targetSha}-999-1`,
    },
    targetSha: fixture.targetSha,
    branchTipSha: fixture.targetSha,
    commitVerifications: [
      {
        sha: fixture.targetSha,
        verification: {
          verified: true,
          reason: "valid",
          verifiedAt: "2026-07-10T00:00:00Z",
        },
      },
    ],
    evidence,
  };
}

describe("release delta evidence v1", () => {
  it("creates and reverifies read-only changelog evidence", () => {
    const fixture = createFixture();
    const inputs = manifestInputs(fixture);
    const manifest = createReleaseDeltaManifest(inputs);

    expect(manifest.mode).toBe("changelog-only-v1");
    expect(manifest.release).toEqual({ version: VERSION, channel: "beta" });
    expect(manifest.changedPaths).toEqual(["CHANGELOG.md"]);
    expect(manifest.source.reusableTreeSha256).toBe(manifest.target.reusableTreeSha256);
    expect(manifest.gates.map((gate: any) => [gate.id, gate.mode])).toEqual([
      ["source-frv", "reuse"],
      ["source-npm", "reuse"],
      ["target-npm", "fresh"],
      ["release-notes", "fresh"],
    ]);
    expect(manifest.packageEvidence.rawRootTarballEqual).toBe(false);
    expect(manifest.packageEvidence.dependencyTarballs).toHaveLength(1);
    expect(manifest.publicationPerformed).toBe(false);
    expect(validateReleaseDeltaManifest(manifest, inputs)).toMatchObject({
      valid: true,
      sourceSha: fixture.sourceSha,
      targetSha: fixture.targetSha,
      publicationPerformed: false,
    });
  });

  it("rejects a target that is not the current release branch tip", () => {
    const fixture = createFixture();
    expect(() =>
      computeReleaseDelta(fixture.root, fixture.policy, fixture.targetSha, fixture.sourceSha),
    ).toThrow("target SHA is not the current target branch tip");
  });

  it("rejects unsigned delta commits", () => {
    const fixture = createFixture();
    const inputs = manifestInputs(fixture);
    inputs.commitVerifications[0].verification.verified = false;
    expect(() => createReleaseDeltaManifest(inputs)).toThrow("is not verified");
  });

  it("rejects any non-changelog path", () => {
    const fixture = createFixture();
    git(fixture.root, ["switch", TARGET_REF]);
    write(fixture.root, "src/index.ts", "export const value = 2;\n");
    git(fixture.root, ["add", "src/index.ts"]);
    git(fixture.root, ["commit", "-m", "fix: product change"]);
    const productTarget = git(fixture.root, ["rev-parse", "HEAD"]);
    expect(() =>
      computeReleaseDelta(fixture.root, fixture.policy, productTarget, productTarget),
    ).toThrow("changed a path not allowed by policy");
  });

  it("audits every delta commit even when an endpoint path is reverted", () => {
    const fixture = createFixture();
    git(fixture.root, ["switch", TARGET_REF]);
    write(fixture.root, "src/index.ts", "export const value = 2;\n");
    git(fixture.root, ["add", "src/index.ts"]);
    git(fixture.root, ["commit", "-m", "test: transient product change"]);
    write(fixture.root, "src/index.ts", "export const value = 1;\n");
    git(fixture.root, ["add", "src/index.ts"]);
    git(fixture.root, ["commit", "-m", "test: revert transient product change"]);
    const revertedTarget = git(fixture.root, ["rev-parse", "HEAD"]);
    expect(() =>
      computeReleaseDelta(fixture.root, fixture.policy, revertedTarget, revertedTarget),
    ).toThrow("changed a path not allowed by policy");
  });

  it("rejects dependency tarball drift", () => {
    const fixture = createFixture();
    const evidence = evidenceFixture(fixture);
    const target = evidence.find((entry) => entry.id === "target-npm")!;
    const changed = Buffer.from("changed-dependency");
    target.artifacts[0].files.set("openclaw-ai.tgz", changed);
    rewritePreflightManifest(target.artifacts[0], (manifest) => {
      manifest.dependencyTarballs[0].tarballSha256 = sha256(changed);
    });
    expect(() => createReleaseDeltaManifest(manifestInputs(fixture, evidence))).toThrow(
      "dependency tarball differs",
    );
  });

  it("rejects package tarballs omitted from the npm preflight manifest", () => {
    const fixture = createFixture();
    const evidence = evidenceFixture(fixture);
    const target = evidence.find((entry) => entry.id === "target-npm")!;
    target.artifacts[0].files.set("unlisted.tgz", Buffer.from("unlisted"));
    expect(() => createReleaseDeltaManifest(manifestInputs(fixture, evidence))).toThrow(
      "artifact inventory differs from policy",
    );
  });

  it("records raw root equality without reusing the target package gate", () => {
    const fixture = createFixture();
    const evidence = evidenceFixture(fixture);
    const target = evidence.find((entry) => entry.id === "target-npm")!;
    const sourceRoot = Buffer.from("source-root");
    target.artifacts[0].files.set("openclaw.tgz", sourceRoot);
    rewritePreflightManifest(target.artifacts[0], (manifest) => {
      manifest.tarballSha256 = sha256(sourceRoot);
    });
    const manifest = createReleaseDeltaManifest(manifestInputs(fixture, evidence));
    expect(manifest.packageEvidence.rawRootTarballEqual).toBe(true);
    expect(manifest.gates.find((gate: any) => gate.id === "target-npm").mode).toBe("fresh");
  });

  it("rejects source FRV evidence that bypasses the strict validator contract", () => {
    const fixture = createFixture();
    const evidence = evidenceFixture(fixture);
    const source = evidence.find((entry) => entry.id === "source-frv")!;
    source.sourceValidation.directRoot = false;
    expect(() => createReleaseDeltaManifest(manifestInputs(fixture, evidence))).toThrow(
      "source FRV is not a trusted direct root",
    );
  });

  it("rejects source FRV evidence with different lane-selection inputs", () => {
    const fixture = createFixture();
    const evidence = evidenceFixture(fixture);
    const source = evidence.find((entry) => entry.id === "source-frv")!;
    source.sourceValidation.validationInputs = {
      ...VALIDATION_INPUTS,
      provider: "anthropic",
    };
    expect(() => createReleaseDeltaManifest(manifestInputs(fixture, evidence))).toThrow(
      "validation inputs differ from policy",
    );
  });

  it("rejects npm preflight metadata for a different package version", () => {
    const fixture = createFixture();
    const evidence = evidenceFixture(fixture);
    const target = evidence.find((entry) => entry.id === "target-npm")!;
    rewritePreflightManifest(target.artifacts[0], (manifest) => {
      manifest.packageVersion = "2026.7.1-beta.2";
    });
    expect(() => createReleaseDeltaManifest(manifestInputs(fixture, evidence))).toThrow(
      "root package version differs",
    );
  });

  it("rejects trusted-main gate workflow SHAs outside producer ancestry", () => {
    const fixture = createFixture();
    const releaseNotes = fixture.policy.gates.find((gate) => gate.id === "release-notes")!;
    releaseNotes.workflowSha = fixture.targetSha;
    write(fixture.root, POLICY_PATH, `${canonicalJson(fixture.policy)}\n`);
    git(fixture.root, ["add", POLICY_PATH]);
    git(fixture.root, ["commit", "-m", "test: move policy"]);
    fixture.workflowSha = git(fixture.root, ["rev-parse", "HEAD"]);
    expect(() => createReleaseDeltaManifest(manifestInputs(fixture))).toThrow(
      "workflow SHA is not on trusted main lineage",
    );
  });

  it("rejects a manifest that claims publication", () => {
    const fixture = createFixture();
    const inputs = manifestInputs(fixture);
    const manifest = createReleaseDeltaManifest(inputs);
    manifest.publicationPerformed = true;
    expect(() => validateReleaseDeltaManifest(manifest, inputs)).toThrow(
      "must not authorize publication",
    );
  });

  it("parses only beta changelog policies", () => {
    const fixture = createFixture();
    expect(() =>
      parseReleaseDeltaPolicy({
        ...fixture.policy,
        allowedPaths: ["CHANGELOG.md", "src/**"],
      }),
    ).toThrow("v1 policy allows only CHANGELOG.md");
  });

  it("binds the policy release branch to the beta stable version", () => {
    const fixture = createFixture();
    expect(() =>
      parseReleaseDeltaPolicy({
        ...fixture.policy,
        targetRef: "release/2026.7.2",
      }),
    ).toThrow("targetRef must match the beta stable version");
  });

  it("rejects non-dispatch evidence runs", () => {
    const fixture = createFixture();
    const evidence = evidenceFixture(fixture);
    evidence[0].run.event = "push";
    expect(() => createReleaseDeltaManifest(manifestInputs(fixture, evidence))).toThrow(
      "run event is not workflow_dispatch",
    );
  });

  it("rejects noncanonical UTF-8 artifact bindings", () => {
    const fixture = createFixture();
    const evidence = evidenceFixture(fixture);
    const target = evidence.find((entry) => entry.id === "target-npm")!;
    target.artifacts[0].files.set("preflight-manifest.json", Buffer.from([0xff]));
    expect(() => createReleaseDeltaManifest(manifestInputs(fixture, evidence))).toThrow(
      "binding member is not canonical UTF-8",
    );
  });

  it("requires producer attempt one", () => {
    const fixture = createFixture();
    const inputs = manifestInputs(fixture);
    inputs.producer.runAttempt = 2;
    expect(() => createReleaseDeltaManifest(inputs)).toThrow(
      "producer must be workflow run attempt 1",
    );
  });

  it("rejects evidence from workflow rerun attempts", () => {
    const fixture = createFixture();
    const evidence = evidenceFixture(fixture);
    const target = evidence.find((entry) => entry.id === "target-npm")!;
    target.run.runAttempt = 2;
    target.job.runAttempt = 2;
    expect(() => createReleaseDeltaManifest(manifestInputs(fixture, evidence))).toThrow(
      "gate target-npm run attempt must be 1",
    );
  });

  it("rejects rerun attempts in CLI evidence bindings", async () => {
    const fixture = createFixture();
    const evidence = evidenceFixture(fixture);
    const bindings = Object.fromEntries(
      evidence.map((entry) => [
        entry.id,
        {
          runId: entry.run.id,
          runAttempt: entry.id === "target-npm" ? 2 : 1,
          jobId: entry.job.id,
          artifacts: Object.fromEntries(
            entry.artifacts.map((artifact) => [artifact.key, artifact.metadata.id]),
          ),
        },
      ]),
    );
    const evidenceRunsPath = path.join(fixture.root, "rerun-evidence-runs.json");
    writeFileSync(evidenceRunsPath, JSON.stringify(bindings));
    await expect(
      runReleaseDeltaEvidence(
        [
          "create",
          "--repo",
          REPOSITORY,
          "--policy",
          POLICY_PATH,
          "--target-sha",
          fixture.targetSha,
          "--workflow-sha",
          fixture.workflowSha,
          "--producer-run-id",
          "999",
          "--producer-run-attempt",
          "1",
          "--producer-workflow-path",
          ".github/workflows/release-delta-evidence.yml",
          "--producer-workflow-ref",
          "refs/heads/main",
          "--producer-artifact-name",
          `release-delta-evidence-${fixture.targetSha}-999-1`,
          "--evidence-runs",
          evidenceRunsPath,
          "--output",
          path.join(fixture.root, "rerun-manifest.json"),
        ],
        { cwd: fixture.root },
      ),
    ).rejects.toThrow("target-npm run attempt must be 1");
  });

  it("runs create and verify through injected GitHub and archive adapters", async () => {
    const fixture = createFixture();
    const evidence = evidenceFixture(fixture);
    const readerRequests: any[] = [];
    const bindings = Object.fromEntries(
      evidence.map((entry) => [
        entry.id,
        {
          runId: entry.run.id,
          runAttempt: entry.run.runAttempt,
          jobId: entry.job.id,
          artifacts: Object.fromEntries(
            entry.artifacts.map((artifact) => [artifact.key, artifact.metadata.id]),
          ),
        },
      ]),
    );
    const runById = new Map(evidence.map((entry) => [entry.run.id, entry]));
    const jobById = new Map(evidence.map((entry) => [entry.job.id, entry.job]));
    const artifactById = new Map(
      evidence.flatMap((entry) =>
        entry.artifacts.map((artifact) => [
          artifact.metadata.id,
          {
            id: artifact.metadata.id,
            name: artifact.metadata.name,
            digest: artifact.metadata.digest,
            size_in_bytes: artifact.metadata.sizeBytes,
            expired: false,
            workflow_run: {
              id: artifact.metadata.runId,
              head_sha: artifact.metadata.workflowSha,
            },
          },
        ]),
      ),
    );
    const archiveById = new Map(
      evidence.flatMap((entry) =>
        entry.artifacts.map((artifact) => [
          artifact.metadata.id,
          { archiveBytes: artifact.archiveBytes, files: artifact.files },
        ]),
      ),
    );
    const sourceValidation = evidence.find((entry) => entry.id === "source-frv")!.sourceValidation;
    const api = (apiPath: string) => {
      if (apiPath.includes("/git/ref/heads/")) {
        return { object: { type: "commit", sha: fixture.targetSha } };
      }
      const commitMatch = /\/commits\/([0-9a-f]{40})$/u.exec(apiPath);
      if (commitMatch) {
        return {
          sha: commitMatch[1],
          commit: {
            verification: {
              verified: true,
              reason: "valid",
              verified_at: "2026-07-10T00:00:00Z",
            },
          },
        };
      }
      const runMatch = /\/actions\/runs\/(\d+)$/u.exec(apiPath);
      if (runMatch) {
        const entry = runById.get(Number(runMatch[1]))!;
        return {
          id: entry.run.id,
          run_attempt: entry.run.runAttempt,
          name: entry.run.name,
          path: entry.run.path,
          event: entry.run.event,
          head_branch: entry.run.headBranch,
          head_repository: { full_name: entry.run.headRepository },
          head_sha: entry.run.headSha,
          html_url: entry.run.url,
          status: entry.run.status,
          conclusion: entry.run.conclusion,
        };
      }
      const jobMatch = /\/actions\/jobs\/(\d+)$/u.exec(apiPath);
      if (jobMatch) {
        const job = jobById.get(Number(jobMatch[1]))!;
        return {
          id: job.id,
          run_id: job.runId,
          run_attempt: job.runAttempt,
          name: job.name,
          head_sha: job.headSha,
          html_url: job.url,
          status: job.status,
          conclusion: job.conclusion,
        };
      }
      const artifactMatch = /\/actions\/artifacts\/(\d+)$/u.exec(apiPath);
      if (artifactMatch) {
        return artifactById.get(Number(artifactMatch[1]));
      }
      throw new Error(`unexpected API path: ${apiPath}`);
    };
    const evidenceRunsPath = path.join(fixture.root, "evidence-runs.json");
    const manifestPath = path.join(fixture.root, "delta-manifest.json");
    writeFileSync(evidenceRunsPath, JSON.stringify(bindings));
    const common = [
      "--repo",
      REPOSITORY,
      "--policy",
      POLICY_PATH,
      "--target-sha",
      fixture.targetSha,
      "--workflow-sha",
      fixture.workflowSha,
      "--producer-run-id",
      "999",
      "--producer-run-attempt",
      "1",
      "--producer-workflow-path",
      ".github/workflows/release-delta-evidence.yml",
      "--producer-workflow-ref",
      "refs/heads/main",
      "--producer-artifact-name",
      `release-delta-evidence-${fixture.targetSha}-999-1`,
    ];
    const overrides = {
      cwd: fixture.root,
      api,
      artifactReader: async (request: any) => {
        readerRequests.push(request);
        const runEntry = runById.get(request.expected.runId)!;
        return {
          ...archiveById.get(request.expected.artifactId),
          artifactMetadata: artifactById.get(request.expected.artifactId),
          binding: {
            ...request.expected,
            workflowStatus: "completed",
            workflowConclusion: "success",
          },
          workflowRun: {
            id: runEntry.run.id,
            run_attempt: runEntry.run.runAttempt,
            path: runEntry.run.path,
            event: runEntry.run.event,
            head_branch: runEntry.run.headBranch,
            head_sha: runEntry.run.headSha,
            status: runEntry.run.status,
            conclusion: runEntry.run.conclusion,
            repository: { full_name: runEntry.run.headRepository },
          },
        };
      },
      sourceFrvValidator: async () => sourceValidation,
      token: "test-token",
    };

    const created = await runReleaseDeltaEvidence(
      ["create", ...common, "--evidence-runs", evidenceRunsPath, "--output", manifestPath],
      overrides,
    );
    expect(sha256(readFileSync(manifestPath))).toBe(created.manifestSha256);
    const result = await runReleaseDeltaEvidence(
      ["verify", ...common, "--manifest", manifestPath],
      overrides,
    );
    expect(result).toMatchObject({
      valid: true,
      targetSha: fixture.targetSha,
      publicationPerformed: false,
    });
    expect(readerRequests).not.toHaveLength(0);
    expect(readerRequests[0]).toMatchObject({
      token: "test-token",
      maxArchiveBytes: 256 * 1024 * 1024,
      expected: {
        repository: REPOSITORY,
        artifactId: readerRequests[0].expected.artifactId,
        artifactName: "source-frv-evidence",
        artifactDigest: readerRequests[0].expected.artifactDigest,
        artifactSizeBytes: readerRequests[0].expected.artifactSizeBytes,
        runId: readerRequests[0].expected.runId,
        runAttempt: 1,
        workflowSha: fixture.evidenceWorkflowSha,
        workflowPath: ".github/workflows/full-release-validation.yml",
        workflowEvent: "workflow_dispatch",
        workflowHeadBranch: "main",
        runStatePolicy: "completed-success",
      },
    });
    expect(readerRequests[0].archivePolicy.expectedEntries).toEqual(["binding.json"]);
    const targetPackageRequest = readerRequests.find(
      (request) => request.expected.artifactName === "target-npm-package",
    );
    expect(targetPackageRequest).toBeDefined();
    expect(targetPackageRequest!.expected).toMatchObject({
      repository: REPOSITORY,
      workflowSha: fixture.targetSha,
      workflowHeadBranch: TARGET_REF,
      runStatePolicy: "completed-success",
    });
  });
});

describe("release delta evidence workflow", () => {
  const workflow = parse(
    readFileSync(".github/workflows/release-delta-evidence.yml", "utf8"),
  ) as Workflow;
  const steps = workflow.jobs.produce.steps;
  const step = (name: string) => {
    const result = steps.find((entry) => entry.name === name);
    if (!result) {
      throw new Error(`missing workflow step: ${name}`);
    }
    return result;
  };

  it("binds the producer path to the observed workflow ref", () => {
    const validate = step("Validate inputs");
    expect(validate.run).toContain('[[ "$GITHUB_WORKFLOW_REF" == "$expected_workflow_ref" ]]');
    expect(validate.run).toContain(
      'producer_workflow_path="${GITHUB_WORKFLOW_REF#${GITHUB_REPOSITORY}/}"',
    );
    expect(validate.run).toContain(
      'printf \'PRODUCER_WORKFLOW_PATH=%s\\n\' "$producer_workflow_path" >> "$GITHUB_ENV"',
    );
    expect(step("Create canonical delta manifest").run).toContain(
      '--producer-workflow-path "$PRODUCER_WORKFLOW_PATH"',
    );
    expect(step("Reverify current GitHub evidence").run).toContain(
      '--producer-workflow-path "$PRODUCER_WORKFLOW_PATH"',
    );
  });

  it("uploads one staged artifact root with stable member names", () => {
    const stage = step("Stage read-only delta evidence");
    expect(stage.env.EVIDENCE_ARTIFACT_DIR).toBe(
      "${{ runner.temp }}/release-delta-evidence-artifact",
    );
    expect(stage.run).toContain(
      'cp -- "$POLICY_PATH" "$EVIDENCE_ARTIFACT_DIR/release-delta-policy.json"',
    );
    expect(step("Upload read-only delta evidence").with.path).toBe(
      "${{ runner.temp }}/release-delta-evidence-artifact",
    );
  });
});
