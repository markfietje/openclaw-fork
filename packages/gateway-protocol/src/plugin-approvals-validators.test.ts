import { describe, expect, it } from "vitest";
import { validatePluginApprovalRequestParams } from "./index.js";

const nullableMetadataFields = [
  "pluginId",
  "detail",
  "args",
  "severity",
  "scope",
  "toolName",
  "toolCallId",
  "allowedDecisions",
  "agentId",
  "sessionKey",
  "approvalReviewerDeviceIds",
  "turnSourceChannel",
  "turnSourceTo",
  "turnSourceAccountId",
  "turnSourceThreadId",
] as const;

describe("plugin approval protocol validators", () => {
  it("validates bounded reviewer-only detail independently from the description", () => {
    const request = {
      title: "Apply workspace skill proposal",
      description: "d".repeat(512),
    };

    expect(validatePluginApprovalRequestParams(request)).toBe(true);
    expect(validatePluginApprovalRequestParams({ ...request, detail: "full tool input" })).toBe(
      true,
    );
    expect(validatePluginApprovalRequestParams({ ...request, detail: "" })).toBe(false);
    expect(validatePluginApprovalRequestParams({ ...request, detail: "x".repeat(16_385) })).toBe(
      false,
    );
    expect(validatePluginApprovalRequestParams({ ...request, description: "d".repeat(513) })).toBe(
      false,
    );
  });

  it("validates bounded redacted args independently from the description", () => {
    const request = {
      title: "Apply workspace skill proposal",
      description: "Apply the pending proposal",
    };

    expect(validatePluginApprovalRequestParams(request)).toBe(true);
    expect(
      validatePluginApprovalRequestParams({ ...request, args: '{"path":"/tmp/notes.txt"}' }),
    ).toBe(true);
    expect(validatePluginApprovalRequestParams({ ...request, args: "" })).toBe(false);
    expect(validatePluginApprovalRequestParams({ ...request, args: "x".repeat(2_001) })).toBe(
      false,
    );
  });

  it.each(nullableMetadataFields)("accepts explicit null for optional %s metadata", (field) => {
    expect(
      validatePluginApprovalRequestParams({
        title: "Apply workspace skill proposal",
        description: "Apply the pending proposal",
        [field]: null,
      }),
    ).toBe(true);
  });
});
