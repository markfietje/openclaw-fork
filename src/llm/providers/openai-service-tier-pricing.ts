import {
  attachUsageBudgetCostMultiplierMetadata,
  attachUsageBudgetUnpriceableCostMetadata,
} from "../../shared/usage-budget-recorded-cost.js";
import type { Model, Usage } from "../types.js";

export type OpenAIServiceTier = "auto" | "default" | "flex" | "priority" | "scale";

const OPENAI_PRIORITY_SERVICE_TIER_COST_MULTIPLIERS: readonly {
  prefix: string;
  multiplier: number;
}[] = [
  { prefix: "gpt-5.5", multiplier: 2.5 },
  { prefix: "gpt-5.4-mini", multiplier: 2 },
  { prefix: "gpt-5.4", multiplier: 2 },
  { prefix: "gpt-5.2", multiplier: 2 },
  { prefix: "gpt-5.1-codex", multiplier: 2 },
  { prefix: "gpt-5-codex", multiplier: 2 },
  { prefix: "gpt-5.1", multiplier: 2 },
  { prefix: "gpt-5-mini", multiplier: 1.8 },
  { prefix: "gpt-5", multiplier: 2 },
  { prefix: "gpt-4.1-mini", multiplier: 1.75 },
  { prefix: "gpt-4.1-nano", multiplier: 2 },
  { prefix: "gpt-4.1", multiplier: 1.75 },
  { prefix: "gpt-4o-2024-05-13", multiplier: 1.75 },
  { prefix: "gpt-4o-mini", multiplier: 5 / 3 },
  { prefix: "gpt-4o", multiplier: 1.7 },
  { prefix: "o4-mini", multiplier: 20 / 11 },
  { prefix: "o3", multiplier: 1.75 },
];

const OPENAI_PRIORITY_SERVICE_TIER_MAX_COST_MULTIPLIER = Math.max(
  ...OPENAI_PRIORITY_SERVICE_TIER_COST_MULTIPLIERS.map((entry) => entry.multiplier),
);

function normalizeOpenAIModelId(model: Pick<Model, "id">): string {
  return model.id
    .trim()
    .toLowerCase()
    .replace(/^openai\//, "");
}

function getOpenAIPriorityServiceTierCostMultiplier(model: Pick<Model, "id">): number | undefined {
  const id = normalizeOpenAIModelId(model);
  const match = OPENAI_PRIORITY_SERVICE_TIER_COST_MULTIPLIERS.find(
    (entry) => id === entry.prefix || id.startsWith(`${entry.prefix}-`),
  );
  return match?.multiplier;
}

export function getOpenAIServiceTierCostMultiplier(
  model: Pick<Model, "id">,
  serviceTier: string | null | undefined,
  options?: { unknownTier?: "standard" | "max" },
): number | undefined {
  const tier = serviceTier?.trim().toLowerCase();
  switch (tier) {
    case "flex":
      return 0.5;
    case "priority":
      return getOpenAIPriorityServiceTierCostMultiplier(model);
    case "default":
      return 1;
    case undefined:
    case "":
    case "auto":
      return options?.unknownTier === "max"
        ? (getOpenAIPriorityServiceTierCostMultiplier(model) ??
            OPENAI_PRIORITY_SERVICE_TIER_MAX_COST_MULTIPLIER)
        : 1;
    case "scale":
      return undefined;
    default:
      return undefined;
  }
}

export function getOpenAIServiceTierBudgetReservationMultiplier(
  model: Pick<Model, "id">,
  serviceTier: string | null | undefined,
): number | undefined {
  const tier = serviceTier?.trim().toLowerCase();
  if (tier === "default" || tier === "flex" || tier === "priority") {
    return getOpenAIServiceTierCostMultiplier(model, tier);
  }
  if (tier === "auto") {
    return getOpenAIServiceTierCostMultiplier(model, tier, { unknownTier: "max" });
  }
  return undefined;
}

function shouldMarkOpenAIServiceTierCost(serviceTier: string | null | undefined): boolean {
  const tier = serviceTier?.trim().toLowerCase();
  return tier !== undefined && tier !== "" && tier !== "auto";
}

function isUnresolvedOpenAIServiceTier(serviceTier: string | null | undefined): boolean {
  const tier = serviceTier?.trim().toLowerCase();
  return tier === undefined || tier === "";
}

export function shouldReserveOpenAIAccountDefaultServiceTierBudget(model: {
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  if (typeof model.provider !== "string" || model.provider.trim().toLowerCase() !== "openai") {
    return false;
  }
  if (typeof model.baseUrl !== "string" || model.baseUrl.trim() === "") {
    return true;
  }
  return model.baseUrl.toLowerCase().includes("api.openai.com");
}

export function applyOpenAIServiceTierPricing(
  usage: Usage,
  serviceTier: string | null | undefined,
  model: Pick<Model, "id"> & { provider?: unknown; baseUrl?: unknown },
) {
  const tier = serviceTier?.trim().toLowerCase();
  const unresolvedAccountDefaultTier =
    isUnresolvedOpenAIServiceTier(serviceTier) &&
    shouldReserveOpenAIAccountDefaultServiceTierBudget(model);
  const explicitAutoTier =
    tier === "auto" && shouldReserveOpenAIAccountDefaultServiceTierBudget(model);
  const multiplier =
    unresolvedAccountDefaultTier || explicitAutoTier
      ? getOpenAIServiceTierBudgetReservationMultiplier(model, serviceTier)
      : getOpenAIServiceTierCostMultiplier(model, serviceTier);
  if (multiplier === undefined) {
    if (shouldMarkOpenAIServiceTierCost(serviceTier) || unresolvedAccountDefaultTier) {
      attachUsageBudgetUnpriceableCostMetadata(
        usage as unknown as Record<string, unknown>,
        tier === "scale" || unresolvedAccountDefaultTier
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
  if (
    usage.cost.total > 0 &&
    (shouldMarkOpenAIServiceTierCost(serviceTier) ||
      unresolvedAccountDefaultTier ||
      explicitAutoTier)
  ) {
    attachUsageBudgetCostMultiplierMetadata(
      usage as unknown as Record<string, unknown>,
      multiplier,
    );
  }
}
