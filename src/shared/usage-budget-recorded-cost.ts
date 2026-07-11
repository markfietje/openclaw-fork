// Shared marker for usage costs already adjusted by budget-owned dispatch pricing.
export const USAGE_BUDGET_RECORDED_COST_METADATA_KEY = "usageBudgetRecordedCost";
export const USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION = 1;

export type UsageBudgetRecordedCostMetadata = {
  schemaVersion: typeof USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION;
  kind: "estimated-model-call-cost" | "provider-billed-model-call-cost";
  costMultiplier: number;
};

export type UsageBudgetUnpriceableCostReason =
  | "capacity-billed-service-tier"
  | "provider-billed-cost-unavailable"
  | "unknown-service-tier";

export type UsageBudgetCostMultiplierMetadata = {
  schemaVersion: typeof USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION;
  kind: "model-call-cost-multiplier";
  costMultiplier: number;
};

export type UsageBudgetUnpriceableCostMetadata = {
  schemaVersion: typeof USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION;
  kind: "unpriceable-model-call-cost";
  reason: UsageBudgetUnpriceableCostReason;
};

export function attachUsageBudgetRecordedCostMetadata(
  usage: Record<string, unknown>,
  costMultiplier: number,
): void {
  if (!Number.isFinite(costMultiplier) || costMultiplier <= 0) {
    return;
  }
  usage[USAGE_BUDGET_RECORDED_COST_METADATA_KEY] = {
    schemaVersion: USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION,
    kind: "estimated-model-call-cost",
    costMultiplier,
  } satisfies UsageBudgetRecordedCostMetadata;
}

export function attachUsageBudgetProviderBilledCostMetadata(usage: Record<string, unknown>): void {
  usage[USAGE_BUDGET_RECORDED_COST_METADATA_KEY] = {
    schemaVersion: USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION,
    kind: "provider-billed-model-call-cost",
    costMultiplier: 1,
  } satisfies UsageBudgetRecordedCostMetadata;
}

export function attachUsageBudgetCostMultiplierMetadata(
  usage: Record<string, unknown>,
  costMultiplier: number,
): void {
  if (!Number.isFinite(costMultiplier) || costMultiplier <= 0) {
    return;
  }
  usage[USAGE_BUDGET_RECORDED_COST_METADATA_KEY] = {
    schemaVersion: USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION,
    kind: "model-call-cost-multiplier",
    costMultiplier,
  } satisfies UsageBudgetCostMultiplierMetadata;
}

export function attachUsageBudgetUnpriceableCostMetadata(
  usage: Record<string, unknown>,
  reason: UsageBudgetUnpriceableCostReason,
): void {
  usage[USAGE_BUDGET_RECORDED_COST_METADATA_KEY] = {
    schemaVersion: USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION,
    kind: "unpriceable-model-call-cost",
    reason,
  } satisfies UsageBudgetUnpriceableCostMetadata;
}

export function hasUsageBudgetUnpriceableCostMetadata(usageRaw: unknown): boolean {
  if (!usageRaw || typeof usageRaw !== "object" || Array.isArray(usageRaw)) {
    return false;
  }
  const metadata = (usageRaw as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const record = metadata as Record<string, unknown>;
  return (
    record.schemaVersion === USAGE_BUDGET_RECORDED_COST_METADATA_SCHEMA_VERSION &&
    record.kind === "unpriceable-model-call-cost"
  );
}
