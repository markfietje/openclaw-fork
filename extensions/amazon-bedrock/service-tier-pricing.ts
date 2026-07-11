// Bedrock service-tier pricing helpers keep provider-specific tier math out of budget policy.
import type { Usage } from "openclaw/plugin-sdk/llm";
import {
  attachUsageBudgetRecordedCostMetadata,
  attachUsageBudgetUnpriceableCostMetadata,
} from "openclaw/plugin-sdk/provider-stream-shared";

export const BEDROCK_SERVICE_TIER_VALUES = ["flex", "priority", "default", "reserved"] as const;
export type BedrockServiceTier = (typeof BEDROCK_SERVICE_TIER_VALUES)[number];

const BEDROCK_FLEX_COST_MULTIPLIER = 0.5;
const BEDROCK_PRIORITY_COST_MULTIPLIER = 1.75;

export function isBedrockServiceTier(value: string): value is BedrockServiceTier {
  return BEDROCK_SERVICE_TIER_VALUES.some((tier) => tier === value);
}

export function readBedrockServiceTierValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

export function getBedrockServiceTierCostMultiplier(
  serviceTier: string | null | undefined,
  options?: { missingTier?: "standard" | "max" },
): number | undefined {
  if (serviceTier === undefined || serviceTier === null) {
    return options?.missingTier === "max" ? BEDROCK_PRIORITY_COST_MULTIPLIER : 1;
  }

  switch (serviceTier.trim().toLowerCase()) {
    case "flex":
      return BEDROCK_FLEX_COST_MULTIPLIER;
    case "priority":
      return BEDROCK_PRIORITY_COST_MULTIPLIER;
    case "default":
      return 1;
    case "reserved":
      return undefined;
    default:
      return undefined;
  }
}

export function getBedrockServiceTierBudgetReservationMultiplier(
  serviceTier: string | null | undefined,
): number | undefined {
  return getBedrockServiceTierCostMultiplier(serviceTier);
}

function shouldMarkBedrockServiceTierCost(serviceTier: string | null | undefined): boolean {
  return serviceTier !== undefined && serviceTier !== null && serviceTier.trim() !== "";
}

export function applyBedrockServiceTierPricing(
  usage: Usage,
  serviceTier: string | null | undefined,
): void {
  const multiplier = getBedrockServiceTierCostMultiplier(serviceTier);
  if (multiplier === undefined) {
    if (shouldMarkBedrockServiceTierCost(serviceTier)) {
      attachUsageBudgetUnpriceableCostMetadata(
        usage as unknown as Record<string, unknown>,
        serviceTier?.trim().toLowerCase() === "reserved"
          ? "capacity-billed-service-tier"
          : "unknown-service-tier",
      );
    }
    return;
  }
  if (multiplier !== 1) {
    usage.cost.input *= multiplier;
    usage.cost.output *= multiplier;
    usage.cost.cacheRead *= multiplier;
    usage.cost.cacheWrite *= multiplier;
    usage.cost.total =
      usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  }
  if (usage.cost.total > 0 && shouldMarkBedrockServiceTierCost(serviceTier)) {
    attachUsageBudgetRecordedCostMetadata(usage as unknown as Record<string, unknown>, multiplier);
  }
}
