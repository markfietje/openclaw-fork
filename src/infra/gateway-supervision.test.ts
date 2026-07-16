import { describe, expect, it } from "vitest";
import {
  assertGatewayServiceMutationAllowed,
  formatExternalSupervisorUpdateRequired,
  isGatewayExternallySupervised,
} from "./gateway-supervision.js";

describe("gateway supervision", () => {
  it.each([
    { value: undefined, expected: "auto" },
    { value: "", expected: "auto" },
    { value: "auto", expected: "auto" },
    { value: "invalid", expected: "auto" },
    { value: " EXTERNAL ", expected: "external" },
  ])("resolves $value as $expected", ({ value, expected }) => {
    const env = { OPENCLAW_SUPERVISOR_MODE: value };

    expect(isGatewayExternallySupervised(env)).toBe(expected === "external");
  });

  it("blocks native service mutation with actionable guidance", () => {
    expect(() =>
      assertGatewayServiceMutationAllowed("restart the gateway", {
        OPENCLAW_SUPERVISOR_MODE: "external",
      }),
    ).toThrow(
      "OpenClaw gateway lifecycle is managed by an external supervisor " +
        "(OPENCLAW_SUPERVISOR_MODE=external). Use that supervisor to restart the gateway.",
    );
  });

  it("explains why self-update must be delegated", () => {
    expect(formatExternalSupervisorUpdateRequired()).toContain(
      "stop the gateway, update and finalize the runtime, then restart it safely",
    );
  });
});
