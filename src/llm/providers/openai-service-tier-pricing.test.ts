// OpenAI service-tier pricing tests cover budget-cost metadata for resolved tiers.
import { describe, expect, it } from "vitest";
import { USAGE_BUDGET_RECORDED_COST_METADATA_KEY } from "../../shared/usage-budget-recorded-cost.js";
import type { Usage } from "../types.js";
import {
  applyOpenAIServiceTierPricing,
  getOpenAIServiceTierBudgetReservationMultiplier,
  getOpenAIServiceTierCostMultiplier,
} from "./openai-service-tier-pricing.js";

describe("applyOpenAIServiceTierPricing", () => {
  it("marks priority-tier adjusted usage cost for budget accounting", () => {
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.001,
        cacheWrite: 0.004,
        total: 0.035,
      },
    } satisfies Usage;

    applyOpenAIServiceTierPricing(usage, "priority", { id: "gpt-5.5" });

    expect(usage.cost.input).toBe(0.025);
    expect(usage.cost.output).toBe(0.05);
    expect(usage.cost.cacheRead).toBe(0.0025);
    expect(usage.cost.cacheWrite).toBe(0.01);
    expect(usage.cost.total).toBeCloseTo(0.0875);
    expect(
      (usage as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toStrictEqual({
      schemaVersion: 1,
      kind: "model-call-cost-multiplier",
      costMultiplier: 2.5,
    });
  });

  it.each([
    { model: "gpt-5.4", multiplier: 2 },
    { model: "gpt-5.4-mini", multiplier: 2 },
    { model: "gpt-4.1", multiplier: 1.75 },
    { model: "openai/gpt-4o-2024-11-20", multiplier: 1.7 },
    { model: "gpt-4o-2024-05-13", multiplier: 1.75 },
    { model: "o4-mini", multiplier: 20 / 11 },
  ])("uses model-specific priority pricing for $model", ({ model, multiplier }) => {
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.001,
        cacheWrite: 0.004,
        total: 0.035,
      },
    } satisfies Usage;

    applyOpenAIServiceTierPricing(usage, "priority", { id: model });

    expect(usage.cost.input).toBeCloseTo(0.01 * multiplier);
    expect(usage.cost.output).toBeCloseTo(0.02 * multiplier);
    expect(usage.cost.cacheRead).toBeCloseTo(0.001 * multiplier);
    expect(usage.cost.cacheWrite).toBeCloseTo(0.004 * multiplier);
    expect(usage.cost.total).toBeCloseTo(0.035 * multiplier);
    expect(
      (usage as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toStrictEqual({
      schemaVersion: 1,
      kind: "model-call-cost-multiplier",
      costMultiplier: multiplier,
    });
  });

  it("marks unsupported priority models as unpriceable", () => {
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

    expect(getOpenAIServiceTierCostMultiplier({ id: "gpt-future" }, "priority")).toBeUndefined();
    expect(
      getOpenAIServiceTierBudgetReservationMultiplier({ id: "gpt-future" }, "priority"),
    ).toBeUndefined();
    expect(getOpenAIServiceTierBudgetReservationMultiplier({ id: "gpt-5.5" }, "auto")).toBe(2.5);
    expect(getOpenAIServiceTierBudgetReservationMultiplier({ id: "gpt-future" }, "auto")).toBe(2.5);

    applyOpenAIServiceTierPricing(usage, "priority", { id: "gpt-future" });

    expect(usage.cost.total).toBe(0.03);
    expect(
      (usage as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toStrictEqual({
      schemaVersion: 1,
      kind: "unpriceable-model-call-cost",
      reason: "unknown-service-tier",
    });
  });

  it("does not mark token-bearing zero-cost usage as recorded budget cost", () => {
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    } satisfies Usage;

    applyOpenAIServiceTierPricing(usage, "priority", { id: "gpt-5.5" });

    expect(usage.cost.total).toBe(0);
    expect(
      (usage as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toBeUndefined();
  });

  it("marks positive default-tier usage cost as budget multiplier evidence", () => {
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

    applyOpenAIServiceTierPricing(usage, "default", { id: "gpt-5.5" });

    expect(usage.cost.total).toBe(0.03);
    expect(
      (usage as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toStrictEqual({
      schemaVersion: 1,
      kind: "model-call-cost-multiplier",
      costMultiplier: 1,
    });
  });

  it("marks Scale Tier and future tiers as unpriceable", () => {
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

    expect(getOpenAIServiceTierCostMultiplier({ id: "gpt-5.5" }, "scale")).toBeUndefined();
    expect(getOpenAIServiceTierCostMultiplier({ id: "gpt-5.5" }, "future-tier")).toBeUndefined();
    expect(
      getOpenAIServiceTierBudgetReservationMultiplier({ id: "gpt-5.5" }, "scale"),
    ).toBeUndefined();
    expect(
      getOpenAIServiceTierBudgetReservationMultiplier({ id: "gpt-5.5" }, "future-tier"),
    ).toBeUndefined();

    applyOpenAIServiceTierPricing(usage, "scale", { id: "gpt-5.5" });

    expect(usage.cost.total).toBe(0.03);
    expect(
      (usage as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toStrictEqual({
      schemaVersion: 1,
      kind: "unpriceable-model-call-cost",
      reason: "capacity-billed-service-tier",
    });
  });

  it.each([undefined, ""])(
    "marks account-default unresolved service tier %s as unpriceable",
    (serviceTier) => {
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

      applyOpenAIServiceTierPricing(usage, serviceTier, {
        id: "gpt-5.5",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      });

      expect(usage.cost.total).toBeCloseTo(0.03);
      expect(
        (usage as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
      ).toStrictEqual({
        schemaVersion: 1,
        kind: "unpriceable-model-call-cost",
        reason: "capacity-billed-service-tier",
      });
    },
  );

  it("marks explicit auto service tier with the conservative reservation multiplier", () => {
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

    applyOpenAIServiceTierPricing(usage, "auto", {
      id: "gpt-5.5",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    });

    expect(usage.cost.input).toBe(0.025);
    expect(usage.cost.output).toBe(0.05);
    expect(usage.cost.total).toBeCloseTo(0.075);
    expect(
      (usage as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toStrictEqual({
      schemaVersion: 1,
      kind: "model-call-cost-multiplier",
      costMultiplier: 2.5,
    });
  });

  it("does not mark unresolved service-tier usage for OpenAI-compatible proxy routes", () => {
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

    applyOpenAIServiceTierPricing(usage, "auto", {
      id: "gpt-5.5",
      provider: "openai",
      baseUrl: "https://openai-proxy.example/v1",
    });

    expect(usage.cost.total).toBe(0.03);
    expect(
      (usage as unknown as Record<string, unknown>)[USAGE_BUDGET_RECORDED_COST_METADATA_KEY],
    ).toBeUndefined();
  });
});
