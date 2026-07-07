// QA Lab tests preserve the explicit disposition of every retired qa-matrix scenario id.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "../../scenario-catalog.js";

type LegacyMatrixScenarioDisposition = {
  category:
    | "canonical-replacement"
    | "native-e2ee"
    | "native-lifecycle-approval"
    | "portable-flow-current-adapter"
    | "portable-flow-message-capabilities"
    | "portable-flow-topology-actors";
  legacyId: string;
  status: "covered" | "migrated" | "retired";
  targetId?: string;
};

const MATRIX_STREAMING_COVERAGE = [
  "extensions/matrix/src/matrix/draft-stream.test.ts",
  "extensions/matrix/src/matrix/monitor/replies.test.ts",
] as const;
const MATRIX_MEDIA_COVERAGE = [
  "extensions/matrix/src/matrix/monitor/handler.audio-preflight.test.ts",
  "extensions/matrix/src/matrix/monitor/media.test.ts",
  "extensions/matrix/src/matrix/monitor/replies.test.ts",
] as const;
const MATRIX_REACTION_COVERAGE = [
  "extensions/matrix/src/matrix/actions/reactions.test.ts",
  "extensions/matrix/src/matrix/monitor/reaction-events.test.ts",
] as const;
const MATRIX_POLICY_COVERAGE = [
  "extensions/matrix/src/group-mentions.test.ts",
  "extensions/matrix/src/matrix/monitor/mentions.test.ts",
] as const;
const MATRIX_SYNC_COVERAGE = [
  "extensions/matrix/src/matrix/monitor/events.test.ts",
  "extensions/matrix/src/matrix/monitor/inbound-dedupe.test.ts",
  "extensions/matrix/src/matrix/monitor/sync-lifecycle.test.ts",
] as const;
const MATRIX_APPROVAL_COVERAGE = [
  "extensions/matrix/src/approval-handler.runtime.test.ts",
  "extensions/matrix/src/approval-native.test.ts",
  "extensions/matrix/src/matrix/monitor/reaction-events.test.ts",
] as const;
const MATRIX_E2EE_COVERAGE = [
  "extensions/matrix/src/cli.test.ts",
  "extensions/matrix/src/matrix/actions/verification.test.ts",
  "extensions/matrix/src/matrix/sdk/crypto-bootstrap.test.ts",
  "extensions/matrix/src/matrix/sdk/crypto-facade.test.ts",
  "extensions/matrix/src/matrix/sdk/verification-manager.test.ts",
  "extensions/qa-lab/src/test-support/matrix/e2ee-client.test.ts",
] as const;
const MATRIX_E2EE_RECOVERY_COVERAGE = [
  "extensions/matrix/src/cli.test.ts",
  "extensions/matrix/src/matrix/client/storage.test.ts",
  "extensions/matrix/src/matrix/sdk/crypto-bootstrap.test.ts",
  "extensions/matrix/src/matrix/sdk/recovery-key-store.test.ts",
] as const;

function resolveCoveredScenarioEvidence(legacyId: string): readonly string[] {
  if (legacyId.startsWith("matrix-e2ee-")) {
    return MATRIX_E2EE_COVERAGE;
  }
  if (legacyId.startsWith("matrix-approval-")) {
    return MATRIX_APPROVAL_COVERAGE;
  }
  if (legacyId.startsWith("matrix-reaction-")) {
    return MATRIX_REACTION_COVERAGE;
  }
  if (
    legacyId.startsWith("matrix-room-tool-progress-") ||
    legacyId === "matrix-room-block-streaming"
  ) {
    return MATRIX_STREAMING_COVERAGE;
  }
  if (
    legacyId === "matrix-room-generated-image-delivery" ||
    legacyId === "matrix-media-type-coverage" ||
    legacyId === "matrix-voice-preflight-mention"
  ) {
    return MATRIX_MEDIA_COVERAGE;
  }
  if (legacyId === "matrix-room-autojoin-invite") {
    return ["extensions/matrix/src/matrix/monitor/auto-join.test.ts"];
  }
  if (
    legacyId.startsWith("matrix-allowbots-") ||
    legacyId === "matrix-mention-metadata-spoof-block"
  ) {
    return MATRIX_POLICY_COVERAGE;
  }
  if (legacyId.startsWith("matrix-inbound-edit-")) {
    return [
      "extensions/matrix/src/matrix/monitor/events.test.ts",
      "extensions/matrix/src/matrix/monitor/inbound-dedupe.test.ts",
    ];
  }
  if (
    legacyId === "matrix-initial-catchup-then-incremental" ||
    legacyId === "matrix-stale-sync-replay-dedupe"
  ) {
    return MATRIX_SYNC_COVERAGE;
  }
  if (legacyId === "matrix-room-membership-loss") {
    return [
      "extensions/matrix/src/matrix/monitor/recent-invite.test.ts",
      "extensions/matrix/src/matrix/monitor/rooms.test.ts",
      "extensions/matrix/src/matrix/monitor/sync-lifecycle.test.ts",
    ];
  }
  if (legacyId === "matrix-homeserver-restart-resume") {
    return [
      "extensions/qa-lab/src/matrix-channel-driver.lifecycle.live.test.ts",
      "qa/scenarios/channels/matrix-restart-resume.yaml",
    ];
  }
  return [];
}

const LEGACY_MATRIX_SCENARIO_DISPOSITIONS = [
  {
    legacyId: "matrix-thread-follow-up",
    category: "portable-flow-current-adapter",
    status: "migrated",
    targetId: "thread-follow-up",
  },
  {
    legacyId: "matrix-thread-root-preservation",
    category: "portable-flow-current-adapter",
    status: "migrated",
    targetId: "matrix-thread-root-preservation",
  },
  {
    legacyId: "matrix-thread-nested-reply-shape",
    category: "portable-flow-current-adapter",
    status: "migrated",
    targetId: "matrix-thread-nested-reply-shape",
  },
  {
    legacyId: "matrix-thread-isolation",
    category: "portable-flow-current-adapter",
    status: "migrated",
    targetId: "thread-isolation",
  },
  {
    legacyId: "matrix-subagent-thread-spawn",
    category: "portable-flow-current-adapter",
    status: "migrated",
    targetId: "subagent-thread-spawn",
  },
  {
    legacyId: "matrix-top-level-reply-shape",
    category: "portable-flow-current-adapter",
    status: "migrated",
    targetId: "channel-top-level-reply-shape",
  },
  {
    legacyId: "matrix-room-thread-reply-override",
    category: "portable-flow-current-adapter",
    status: "migrated",
    targetId: "thread-reply-override",
  },
  {
    legacyId: "matrix-room-partial-streaming-preview",
    category: "portable-flow-message-capabilities",
    status: "migrated",
    targetId: "matrix-room-partial-streaming-preview",
  },
  {
    legacyId: "matrix-room-quiet-streaming-preview",
    category: "portable-flow-message-capabilities",
    status: "migrated",
    targetId: "matrix-room-quiet-streaming-preview",
  },
  {
    legacyId: "matrix-room-tool-progress-preview",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-room-tool-progress-command-preview",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-room-tool-progress-preview-opt-out",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-room-tool-progress-error",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-room-tool-progress-mention-safety",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-room-block-streaming",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-room-image-understanding-attachment",
    category: "portable-flow-message-capabilities",
    status: "migrated",
    targetId: "matrix-room-image-understanding-attachment",
  },
  {
    legacyId: "matrix-room-generated-image-delivery",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-media-type-coverage",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-voice-preflight-mention",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-attachment-only-ignored",
    category: "portable-flow-message-capabilities",
    status: "migrated",
    targetId: "matrix-attachment-only-ignored",
  },
  {
    legacyId: "matrix-unsupported-media-safe",
    category: "portable-flow-message-capabilities",
    status: "migrated",
    targetId: "matrix-unsupported-media-safe",
  },
  {
    legacyId: "matrix-dm-reply-shape",
    category: "portable-flow-topology-actors",
    status: "migrated",
    targetId: "dm-chat-baseline",
  },
  {
    legacyId: "matrix-dm-shared-session-notice",
    category: "portable-flow-topology-actors",
    status: "migrated",
    targetId: "dm-shared-session",
  },
  {
    legacyId: "matrix-dm-thread-reply-override",
    category: "portable-flow-topology-actors",
    status: "migrated",
    targetId: "matrix-dm-thread-reply-override",
  },
  {
    legacyId: "matrix-dm-per-room-session-override",
    category: "portable-flow-topology-actors",
    status: "migrated",
    targetId: "dm-per-room-session",
  },
  {
    legacyId: "matrix-room-autojoin-invite",
    category: "portable-flow-topology-actors",
    status: "covered",
  },
  {
    legacyId: "matrix-secondary-room-reply",
    category: "portable-flow-topology-actors",
    status: "migrated",
    targetId: "channel-secondary-conversation-isolation",
  },
  {
    legacyId: "matrix-secondary-room-open-trigger",
    category: "portable-flow-topology-actors",
    status: "migrated",
    targetId: "matrix-secondary-room-open-trigger",
  },
  {
    legacyId: "matrix-reaction-notification",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-reaction-threaded",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-reaction-not-a-reply",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-reaction-redaction-observed",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-approval-exec-metadata-single-event",
    category: "native-lifecycle-approval",
    status: "covered",
  },
  {
    legacyId: "matrix-approval-exec-metadata-chunked",
    category: "native-lifecycle-approval",
    status: "covered",
  },
  {
    legacyId: "matrix-approval-plugin-metadata-single-event",
    category: "native-lifecycle-approval",
    status: "covered",
  },
  {
    legacyId: "matrix-approval-deny-reaction",
    category: "native-lifecycle-approval",
    status: "covered",
  },
  {
    legacyId: "matrix-approval-thread-target",
    category: "native-lifecycle-approval",
    status: "covered",
  },
  {
    legacyId: "matrix-approval-channel-target-both",
    category: "native-lifecycle-approval",
    status: "covered",
  },
  {
    legacyId: "matrix-initial-catchup-then-incremental",
    category: "native-lifecycle-approval",
    status: "covered",
  },
  {
    legacyId: "matrix-stale-sync-replay-dedupe",
    category: "native-lifecycle-approval",
    status: "covered",
  },
  {
    legacyId: "matrix-room-membership-loss",
    category: "portable-flow-topology-actors",
    status: "covered",
  },
  {
    legacyId: "matrix-homeserver-restart-resume",
    category: "native-lifecycle-approval",
    status: "covered",
  },
  {
    legacyId: "matrix-mention-gating",
    category: "canonical-replacement",
    status: "migrated",
    targetId: "channel-mention-gating",
  },
  {
    legacyId: "matrix-allowbots-default-block",
    category: "portable-flow-topology-actors",
    status: "covered",
  },
  {
    legacyId: "matrix-allowbots-true-unmentioned-open-room",
    category: "portable-flow-topology-actors",
    status: "covered",
  },
  {
    legacyId: "matrix-allowbots-mentions-mentioned-room",
    category: "portable-flow-topology-actors",
    status: "covered",
  },
  {
    legacyId: "matrix-allowbots-mentions-unmentioned-open-room-block",
    category: "portable-flow-topology-actors",
    status: "covered",
  },
  {
    legacyId: "matrix-allowbots-mentions-dm-unmentioned",
    category: "portable-flow-topology-actors",
    status: "covered",
  },
  {
    legacyId: "matrix-allowbots-room-override-blocks-account-true",
    category: "portable-flow-topology-actors",
    status: "covered",
  },
  {
    legacyId: "matrix-allowbots-room-override-enables-account-off",
    category: "portable-flow-topology-actors",
    status: "covered",
  },
  {
    legacyId: "matrix-allowbots-self-sender-ignored",
    category: "portable-flow-topology-actors",
    status: "covered",
  },
  {
    legacyId: "matrix-mxid-prefixed-command-block",
    category: "portable-flow-current-adapter",
    status: "migrated",
    targetId: "matrix-mxid-prefixed-command-block",
  },
  {
    legacyId: "matrix-mention-metadata-spoof-block",
    category: "portable-flow-current-adapter",
    status: "covered",
  },
  {
    legacyId: "matrix-observer-allowlist-override",
    category: "portable-flow-current-adapter",
    status: "migrated",
    targetId: "matrix-allowlist-hot-reload",
  },
  {
    legacyId: "matrix-allowlist-block",
    category: "canonical-replacement",
    status: "migrated",
    targetId: "channel-sender-allowlist",
  },
  {
    legacyId: "matrix-multi-actor-ordering",
    category: "portable-flow-current-adapter",
    status: "migrated",
    targetId: "channel-multi-actor-ordering",
  },
  {
    legacyId: "matrix-inbound-edit-ignored",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  {
    legacyId: "matrix-inbound-edit-no-duplicate-trigger",
    category: "portable-flow-message-capabilities",
    status: "covered",
  },
  { legacyId: "matrix-e2ee-basic-reply", category: "native-e2ee", status: "covered" },
  {
    legacyId: "matrix-e2ee-state-after-missing-encryption",
    category: "native-e2ee",
    status: "covered",
  },
  { legacyId: "matrix-e2ee-thread-follow-up", category: "native-e2ee", status: "covered" },
  { legacyId: "matrix-e2ee-bootstrap-success", category: "native-e2ee", status: "covered" },
  { legacyId: "matrix-e2ee-recovery-key-lifecycle", category: "native-e2ee", status: "covered" },
  {
    legacyId: "matrix-e2ee-recovery-owner-verification-required",
    category: "native-e2ee",
    status: "covered",
  },
  {
    legacyId: "matrix-e2ee-cli-account-add-enable-e2ee",
    category: "native-e2ee",
    status: "covered",
  },
  { legacyId: "matrix-e2ee-cli-encryption-setup", category: "native-e2ee", status: "covered" },
  {
    legacyId: "matrix-e2ee-cli-encryption-setup-idempotent",
    category: "native-e2ee",
    status: "covered",
  },
  {
    legacyId: "matrix-e2ee-cli-encryption-setup-bootstrap-failure",
    category: "native-e2ee",
    status: "covered",
  },
  { legacyId: "matrix-e2ee-cli-recovery-key-setup", category: "native-e2ee", status: "covered" },
  { legacyId: "matrix-e2ee-cli-recovery-key-invalid", category: "native-e2ee", status: "covered" },
  {
    legacyId: "matrix-e2ee-cli-encryption-setup-multi-account",
    category: "native-e2ee",
    status: "covered",
  },
  {
    legacyId: "matrix-e2ee-cli-setup-then-gateway-reply",
    category: "native-e2ee",
    status: "covered",
  },
  { legacyId: "matrix-e2ee-cli-self-verification", category: "native-e2ee", status: "covered" },
  {
    legacyId: "matrix-e2ee-state-loss-external-recovery-key",
    category: "native-e2ee",
    status: "retired",
  },
  {
    legacyId: "matrix-e2ee-state-loss-stored-recovery-key",
    category: "native-e2ee",
    status: "retired",
  },
  {
    legacyId: "matrix-e2ee-state-loss-no-recovery-key",
    category: "native-e2ee",
    status: "retired",
  },
  {
    legacyId: "matrix-e2ee-stale-recovery-key-after-backup-reset",
    category: "native-e2ee",
    status: "retired",
  },
  {
    legacyId: "matrix-e2ee-server-backup-deleted-local-state-intact",
    category: "native-e2ee",
    status: "retired",
  },
  {
    legacyId: "matrix-e2ee-server-backup-deleted-local-reupload-restores",
    category: "native-e2ee",
    status: "retired",
  },
  {
    legacyId: "matrix-e2ee-corrupt-crypto-idb-snapshot",
    category: "native-e2ee",
    status: "retired",
  },
  {
    legacyId: "matrix-e2ee-server-device-deleted-local-state-intact",
    category: "native-e2ee",
    status: "retired",
  },
  {
    legacyId: "matrix-e2ee-server-device-deleted-relogin-recovers",
    category: "native-e2ee",
    status: "retired",
  },
  {
    legacyId: "matrix-e2ee-sync-state-loss-crypto-intact",
    category: "native-e2ee",
    status: "retired",
  },
  {
    legacyId: "matrix-e2ee-history-exists-backup-empty",
    category: "native-e2ee",
    status: "retired",
  },
  { legacyId: "matrix-e2ee-device-sas-verification", category: "native-e2ee", status: "covered" },
  { legacyId: "matrix-e2ee-qr-verification", category: "native-e2ee", status: "covered" },
  { legacyId: "matrix-e2ee-stale-device-hygiene", category: "native-e2ee", status: "covered" },
  { legacyId: "matrix-e2ee-dm-sas-verification", category: "native-e2ee", status: "covered" },
  { legacyId: "matrix-e2ee-restart-resume", category: "native-e2ee", status: "covered" },
  {
    legacyId: "matrix-e2ee-verification-notice-no-trigger",
    category: "native-e2ee",
    status: "covered",
  },
  { legacyId: "matrix-e2ee-artifact-redaction", category: "native-e2ee", status: "covered" },
  { legacyId: "matrix-e2ee-media-image", category: "native-e2ee", status: "covered" },
  { legacyId: "matrix-e2ee-key-bootstrap-failure", category: "native-e2ee", status: "covered" },
  {
    legacyId: "matrix-e2ee-wrong-account-recovery-key",
    category: "native-e2ee",
    status: "covered",
  },
] as const satisfies readonly LegacyMatrixScenarioDisposition[];

describe("retired qa-matrix scenario parity ledger", () => {
  it("classifies all 94 legacy scenario ids exactly once", () => {
    const legacyIds = LEGACY_MATRIX_SCENARIO_DISPOSITIONS.map((entry) => entry.legacyId);
    expect(legacyIds).toHaveLength(94);
    expect(new Set(legacyIds).size).toBe(94);
  });

  it("keeps every completed migration attached to a canonical QA Lab scenario", () => {
    const migrated = LEGACY_MATRIX_SCENARIO_DISPOSITIONS.filter(
      (entry) => entry.status === "migrated",
    );
    expect(migrated.length).toBeGreaterThan(0);
    for (const entry of migrated) {
      expect(entry.targetId, entry.legacyId).toBeTruthy();
      expect(readQaScenarioById(entry.targetId ?? "").id).toBe(entry.targetId);
    }
  });

  it("keeps stronger current-owner coverage for every non-migrated maintained behavior", () => {
    for (const entry of LEGACY_MATRIX_SCENARIO_DISPOSITIONS) {
      const targetId = "targetId" in entry ? entry.targetId : undefined;
      expect(entry.status === "migrated").toBe(Boolean(targetId));
      if (entry.status !== "covered") {
        continue;
      }
      const evidence = resolveCoveredScenarioEvidence(entry.legacyId);
      expect(evidence.length, entry.legacyId).toBeGreaterThan(0);
      for (const evidencePath of evidence) {
        expect(existsSync(evidencePath), `${entry.legacyId}: ${evidencePath}`).toBe(true);
      }
    }
  });

  it("retires only qa-matrix-specific destructive E2EE fault injection", () => {
    const retired = LEGACY_MATRIX_SCENARIO_DISPOSITIONS.filter(
      (entry) => entry.status === "retired",
    );
    expect(retired).toHaveLength(11);
    for (const entry of retired) {
      expect(entry.legacyId).toMatch(
        /^matrix-e2ee-(state-loss|stale-recovery-key|server-backup-deleted|corrupt-crypto-idb|server-device-deleted|sync-state-loss|history-exists)/,
      );
    }
    for (const evidencePath of MATRIX_E2EE_RECOVERY_COVERAGE) {
      expect(existsSync(evidencePath), evidencePath).toBe(true);
    }
  });
});
