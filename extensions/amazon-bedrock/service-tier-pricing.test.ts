// Bedrock service-tier pricing tests cover conservative budget multipliers.
import type { Usage } from "openclaw/plugin-sdk/llm";
import { USAGE_BUDGET_RECORDED_COST_METADATA_KEY } from "openclaw/plugin-sdk/provider-stream-shared";
import { describe, expect, it } from "vitest";
import {
  applyBedrockServiceTierPricing,
  getBedrockServiceTierBudgetReservationMultiplier,
  getBedrockServiceTierCostMultiplier,
} from "./service-tier-pricing.js";

describe("Bedrock service-tier pricing", () => {
  it("uses known multipliers for explicit priced tiers", () => {
    expect(getBedrockServiceTierCostMultiplier("default")).toBe(1);
    expect(getBedrockServiceTierCostMultiplier("flex")).toBe(0.5);
    expect(getBedrockServiceTierCostMultiplier("priority")).toBe(1.75);
  });

  it("returns reservation multipliers only for priced tiers", () => {
    expect(getBedrockServiceTierCostMultiplier("reserved")).toBeUndefined();
    expect(getBedrockServiceTierCostMultiplier("future-tier")).toBeUndefined();
    expect(getBedrockServiceTierBudgetReservationMultiplier("reserved")).toBeUndefined();
    expect(getBedrockServiceTierBudgetReservationMultiplier("future-tier")).toBeUndefined();
    expect(getBedrockServiceTierBudgetReservationMultiplier(undefined)).toBe(1);
  });

  it("marks completed reserved-tier usage as unpriceable", () => {
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.03,
      },
    } satisfies Usage;

    applyBedrockServiceTierPricing(usage, "reserved");

    expect(usage.cost.total).toBe(0.03);
    expect(
      (usage as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toStrictEqual({
      schemaVersion: 1,
      kind: "unpriceable-model-call-cost",
      reason: "capacity-billed-service-tier",
    });
  });
});
