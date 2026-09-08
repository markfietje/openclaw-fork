/**
 * Truthglass: plugin approvals carry the tool-call truth (args) beside the
 * plugin-authored prose — redacted like persistence, capped with a VISIBLE
 * truncation marker, at BOTH the embedded broker and the gateway transport.
 * The approver sees the raw act, not just the plugin's summary of it.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/config.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  buildApprovalArgs,
  resolveBeforeToolCallApprovalOutcome,
} from "./agent-tools.before-tool-call.approval.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

const APPROVAL = {
  pluginId: "brain",
  title: "Write memory",
  description: "Approve the ingest of one document",
} as const;

function approvalOutcome(baseParams: unknown, signal?: AbortSignal) {
  return resolveBeforeToolCallApprovalOutcome({
    result: { requireApproval: { ...APPROVAL } },
    toolName: "brain_ingest",
    baseParams,
    signal,
  });
}

describe("plugin approval args — the approver sees the truth", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    setEmbeddedPluginApprovalBroker(null);
    setEmbeddedMode(false);
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("plugin_approval_payload_includes_args", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    setEmbeddedMode(true);
    setEmbeddedPluginApprovalBroker(broker);
    const requested: Array<{ id: string; request: Record<string, unknown> }> = [];
    const unsubscribe = broker.subscribe((event) => {
      if (event.event === "plugin.approval.requested") {
        requested.push({
          id: event.payload.id,
          request: event.payload.request as Record<string, unknown>,
        });
      }
    });
    try {
      const outcome = approvalOutcome({ path: "/tmp/notes.txt", content: "hello" });
      await vi.waitFor(() => expect(requested).toHaveLength(1));
      const { id, request } = requested[0]!;
      expect(request.title).toBe(APPROVAL.title);
      expect(request.description).toBe(APPROVAL.description);
      expect(request.toolName).toBe("brain_ingest");
      expect(request.args).toContain('"path":"/tmp/notes.txt"');
      expect(request.args).toContain('"content":"hello"');
      expect(broker.resolve(id, "deny")).toBe(true);
      await expect(outcome).resolves.toMatchObject({ blocked: true });
    } finally {
      unsubscribe();
    }
  });

  it("args_redacted_like_persistence", () => {
    const args = buildApprovalArgs({
      token: "super-secret-value-123",
      sk: "sk-live-abcdef1234567890",
      path: "/tmp/notes.txt",
    });
    expect(args).toContain("/tmp/notes.txt");
    expect(args).not.toContain("super-secret-value-123");
    expect(args).not.toContain("sk-live-abcdef1234567890");
  });

  it("args_truncation_is_visible_not_silent", () => {
    const blob = "x".repeat(5_000);
    const args = buildApprovalArgs({ blob });
    expect(args).not.toBeNull();
    expect(args!.startsWith('{"blob":"xx')).toBe(true);
    const match = args!.match(/\[…truncated (\d+) chars\]$/);
    expect(match).not.toBeNull();
    // The marker states the EXACT elided count (no silent elision).
    const serialized = JSON.stringify({ blob });
    expect(Number(match![1])).toBe(serialized.length - 2_000);
    // Untruncated args carry no marker.
    expect(buildApprovalArgs({ small: "value" })).not.toMatch(/truncated/);
  });

  it("embedded_and_gateway_payloads_parity", async () => {
    let captured: Record<string, unknown> | undefined;
    mockCallGatewayTool.mockImplementation(async (_method, _options, request, extra) => {
      captured = request as Record<string, unknown>;
      return new Promise((_resolve, reject) => {
        extra?.signal?.addEventListener("abort", () => reject(extra.signal?.reason), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    const baseParams = { path: "/tmp/notes.txt", content: "hello" };
    const outcome = approvalOutcome(baseParams, controller.signal);
    try {
      await vi.waitFor(() => expect(captured).toBeDefined());
      // The gateway payload carries the SAME args the embedded broker does —
      // computed once, both surfaces see the identical truth.
      expect(captured!.args).toBe(buildApprovalArgs(baseParams));
      expect(captured!.toolName).toBe("brain_ingest");
      expect(captured!.title).toBe(APPROVAL.title);
    } finally {
      controller.abort(new Error("test transport done"));
      await outcome;
    }
  });

  it("exec_approval_unchanged", async () => {
    // The change is purely additive on the plugin transport: every legacy
    // field survives beside args, and the prose stays (context matters).
    let captured: Record<string, unknown> | undefined;
    mockCallGatewayTool.mockImplementation(async (_method, _options, request, extra) => {
      captured = request as Record<string, unknown>;
      return new Promise((_resolve, reject) => {
        extra?.signal?.addEventListener("abort", () => reject(extra.signal?.reason), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    const outcome = approvalOutcome({ path: "/tmp/x" }, controller.signal);
    try {
      await vi.waitFor(() => expect(captured).toBeDefined());
      for (const legacyField of [
        "title",
        "description",
        "severity",
        "allowedDecisions",
        "toolName",
        "toolCallId",
        "agentId",
        "sessionKey",
        "timeoutMs",
        "twoPhase",
      ]) {
        expect(captured).toHaveProperty(legacyField);
      }
      expect(captured!.twoPhase).toBe(true);
      // Exec approvals keep their own transport shape (command/commandArgv);
      // this module never touched it — asserted by bash-tools' own suite.
      expect(captured!.method).toBeUndefined();
    } finally {
      controller.abort(new Error("test transport done"));
      await outcome;
    }
  });
});
