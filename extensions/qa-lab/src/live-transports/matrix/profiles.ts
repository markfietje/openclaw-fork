export const MATRIX_QA_RELEASE_SCENARIO_IDS = [
  "channel-chat-baseline",
  "matrix-allowlist-hot-reload",
] as const;

export const MATRIX_QA_TRANSPORT_SCENARIO_IDS = [
  ...MATRIX_QA_RELEASE_SCENARIO_IDS,
  "matrix-restart-resume",
  "matrix-restart-replay-dedupe",
  "matrix-post-restart-room-continue",
] as const;

const MATRIX_QA_PROFILE_SCENARIO_IDS = {
  all: MATRIX_QA_TRANSPORT_SCENARIO_IDS,
  fast: MATRIX_QA_RELEASE_SCENARIO_IDS,
  release: MATRIX_QA_RELEASE_SCENARIO_IDS,
  transport: MATRIX_QA_TRANSPORT_SCENARIO_IDS,
} as const;

export type MatrixQaProfile = keyof typeof MATRIX_QA_PROFILE_SCENARIO_IDS;

export function resolveMatrixQaScenarioIds(params: {
  profile?: string;
  scenarioIds?: readonly string[];
}): string[] {
  if (params.scenarioIds && params.scenarioIds.length > 0) {
    return [...params.scenarioIds];
  }
  const profile = params.profile?.trim() || "all";
  if (!(profile in MATRIX_QA_PROFILE_SCENARIO_IDS)) {
    throw new Error(
      `Unknown QA Lab Matrix profile "${profile}". Expected one of: all, fast, release, transport.`,
    );
  }
  return [...MATRIX_QA_PROFILE_SCENARIO_IDS[profile as MatrixQaProfile]];
}
