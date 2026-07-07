// Builds the first read-only claw lifecycle plan.
import { buildClawArtifactPreview } from "./artifacts.js";
import {
  CLAW_PLAN_SCHEMA_VERSION,
  type ClawDiagnostic,
  type ClawManifest,
  type ClawPlan,
  type ClawPlanEntry,
} from "./types.js";

const CONSENT_KINDS = new Set(["workspaceFile", "persona", "heartbeat", "schedule", "automation"]);

function entryTarget(entry: ClawManifest["entries"][number]): string | undefined {
  if ("selector" in entry) {
    return entry.selector;
  }
  if ("path" in entry) {
    return entry.path;
  }
  return entry.id;
}

function entrySource(entry: ClawManifest["entries"][number]): string | undefined {
  if ("source" in entry) {
    return entry.source;
  }
  return undefined;
}

function planKnownEntry(entry: ClawManifest["entries"][number]): ClawPlanEntry {
  const required = entry.required ?? true;

  if ("selector" in entry) {
    const artifact = buildClawArtifactPreview(entry);
    return {
      id: entry.id,
      kind: entry.kind,
      required,
      decision: artifact.supported ? "inspectOnly" : "blockedUnsupported",
      target: entryTarget(entry),
      artifact,
      reason: artifact.supported
        ? `This entry can be resolved by a future installer through the ${artifact.installSurface} install surface; this PR previews artifact and provenance metadata only.`
        : "This package selector is not supported by the artifact preview and would block a future installer until rewritten.",
    };
  }

  const requiresConsent = CONSENT_KINDS.has(entry.kind);
  return {
    id: entry.id,
    kind: entry.kind,
    required,
    decision: requiresConsent ? "requiresConsent" : "inspectOnly",
    target: entryTarget(entry),
    source: entrySource(entry),
    reason: requiresConsent
      ? "This entry would require explicit user consent before a future install command mutates workspace files or automation state."
      : "This PR only validates and plans local claw manifests; install resolution is intentionally deferred.",
  };
}

export function buildClawPlan(params: {
  manifest: ClawManifest;
  diagnostics?: ClawDiagnostic[];
  sourcePath?: string;
}): ClawPlan {
  const knownEntries = params.manifest.entries.map(planKnownEntry);
  const unknownEntries: ClawPlanEntry[] = params.manifest.optionalUnknownEntries.map(
    (entry, index) => ({
      id: entry.id ?? `optional-unknown-${index + 1}`,
      kind: entry.kind,
      required: false,
      decision: "blockedUnsupported",
      reason:
        "Optional entry kind is not supported by this OpenClaw version and would be skipped by a future installer.",
    }),
  );
  const entries = [...knownEntries, ...unknownEntries];
  const optionalEntries = entries.filter((entry) => !entry.required).length;
  const requiresConsent = entries.filter((entry) => entry.decision === "requiresConsent").length;
  const unsupportedEntries = entries.filter((entry) => entry.decision === "blockedUnsupported");

  return {
    schemaVersion: CLAW_PLAN_SCHEMA_VERSION,
    readOnly: true,
    claw: {
      id: params.manifest.id,
      name: params.manifest.name,
      version: params.manifest.version,
      ...(params.sourcePath ? { sourcePath: params.sourcePath } : {}),
    },
    summary: {
      totalEntries: entries.length,
      requiredEntries: entries.length - optionalEntries,
      optionalEntries,
      requiresConsent,
      unsupportedRequiredEntries: unsupportedEntries.filter((entry) => entry.required).length,
      unsupportedOptionalEntries: unsupportedEntries.filter((entry) => !entry.required).length,
    },
    entries,
    diagnostics: params.diagnostics ?? [],
  };
}
