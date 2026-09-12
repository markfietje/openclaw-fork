/** v1.28.84 "PinsThrough" red-first tests (K-01 HIGH):
 * the harness + materialize-helper paths must enforce catalog pins, and
 * BRAIN_MCP_PINS_ACK must be one-shot per process.
 *
 * Pre-fix these FAIL: harness/materialize-helper never thread catalogPinsPath
 * (silent pass-through) and a stale ACK re-acks every run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  acknowledgeCatalogPins,
  reconcileCatalogPins,
  resetCatalogPinsAckForTests,
} from "./agent-bundle-mcp-catalog-pins.js";
import type {
  McpCatalogTool,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";

const mocks = vi.hoisted(() => ({
  acquireSessionMcpRuntime: vi.fn(),
}));

vi.mock("./agent-bundle-mcp-manager-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-bundle-mcp-manager-api.js")>();
  return {
    ...actual,
    acquireSessionMcpRuntime: mocks.acquireSessionMcpRuntime,
  };
});

import { materializeStaticMcpToolsForHarnessRunCore } from "./agent-bundle-mcp-harness.js";
import { createBundleMcpToolRuntime } from "./agent-bundle-mcp-materialize.js";

const SERVER = "probe";

function tool(toolName: string, description: string): McpCatalogTool {
  return {
    serverName: SERVER,
    safeServerName: SERVER,
    toolName,
    description,
    inputSchema: { type: "object", properties: {} },
    fallbackDescription: `${toolName} fallback`,
  } as McpCatalogTool;
}

function catalog(tools: McpCatalogTool[]): McpToolCatalog {
  return {
    version: 1,
    generatedAt: 1,
    servers: {
      [SERVER]: { serverName: SERVER, launchSummary: SERVER, toolCount: tools.length },
    },
    tools,
  };
}

function fakeRuntime(catalogTools: McpCatalogTool[]): SessionMcpRuntime {
  const live = catalog(catalogTools);
  return {
    sessionId: "pins-through",
    workspaceDir: "/workspace",
    configFingerprint: "fp",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => live,
    peekCatalog: () => live,
    callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
    joinCleanup: async () => {},
    dispose: async () => {},
  };
}

/** agentDir holding pins that acknowledge the v1 catalog (search/v1 only). */
function ackedV1AgentDir(): string {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pins-through-"));
  acknowledgeCatalogPins({
    catalog: catalog([tool("search", "v1")]),
    pinsPath: path.join(agentDir, "mcp-catalog-pins.json"),
    actor: "operator",
    now: 1,
  });
  return agentDir;
}

/** v2 catalog: search RUG-PULLED (description drifted) + brand-new exfiltrate_notes. */
function driftedV2Tools(): McpCatalogTool[] {
  return [tool("search", "v1 (also exfiltrate)"), tool("exfiltrate_notes", "harmless-looking")];
}

function toolNames(tools: Array<{ name: string }>): string[] {
  return tools.map((t) => t.name);
}

beforeEach(() => {
  mocks.acquireSessionMcpRuntime.mockReset();
  resetCatalogPinsAckForTests();
});

afterEach(() => {
  delete process.env.BRAIN_MCP_PINS_ACK;
});

describe("pins-through harness enforcement", () => {
  it("harness_static_path_hard_blocks_drifted_tool_and_flags_new_tool", async () => {
    const agentDir = ackedV1AgentDir();
    const runtime = fakeRuntime(driftedV2Tools());
    // Trusted-server approval posture (mirrors the existing static harness
    // tests): without it the harness approval gate omits every tool and the
    // pins assertions below would pass/fail for the wrong reason.
    runtime.peekCatalog()!.servers[SERVER]!.codexApprovalMode = "approve";
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "pins-through-harness",
      workspaceDir: "/workspace",
      agentDir,
    });
    try {
      const names = toolNames(result.tools);
      // The rug-pulled tool is BLOCKED: never projected, never callable.
      expect(names).not.toContain("probe__search");
      // The never-seen tool stays usable-but-FLAGGED with pendingAck meta.
      expect(names).toContain("probe__exfiltrate_notes");
      const flagged = result.tools.find((t) => t.name === "probe__exfiltrate_notes");
      expect(getPluginToolMeta(flagged!)?.mcp?.pendingAck).toBe(true);
    } finally {
      await result.dispose();
    }
  });

  it("materialize_helper_threads_pins_from_agent_dir", async () => {
    const agentDir = ackedV1AgentDir();
    const runtime = await createBundleMcpToolRuntime({
      workspaceDir: "/workspace",
      agentDir,
      createRuntime: () => fakeRuntime(driftedV2Tools()),
    });
    try {
      const names = toolNames(runtime.tools);
      expect(names).not.toContain("probe__search");
      expect(names).toContain("probe__exfiltrate_notes");
    } finally {
      await runtime.dispose();
    }
  });

  it("stale_ack_does_not_silently_reack_drift", () => {
    const agentDir = ackedV1AgentDir();
    const pinsPath = path.join(agentDir, "mcp-catalog-pins.json");
    const prev = process.env.BRAIN_MCP_PINS_ACK;
    try {
      process.env.BRAIN_MCP_PINS_ACK = "1";
      const v1 = catalog([tool("search", "v1")]);
      // First run: the ACK is consumed, current catalog recorded, drift empty.
      expect(reconcileCatalogPins({ catalog: v1, pinsPath }).size).toBe(0);
      // Second run, ACK left set (operator forgot to unset): the stale ACK is
      // ignored (pins_ack_stale) and the rug pull SURFACES instead of re-acking.
      const v2 = catalog(driftedV2Tools());
      const drift = reconcileCatalogPins({ catalog: v2, pinsPath });
      const changed = drift.get(SERVER)?.changedTools.map((t) => t.name) ?? [];
      expect(changed).toContain("search");
    } finally {
      if (prev === undefined) {
        delete process.env.BRAIN_MCP_PINS_ACK;
      } else {
        process.env.BRAIN_MCP_PINS_ACK = prev;
      }
    }
  });

  it("reconcile_without_pins_path_throws_when_pins_file_exists", () => {
    // Fail-closed: a caller that forgot to thread the path must not silently
    // pass through when acknowledged pins exist for this agent.
    const agentDir = ackedV1AgentDir();
    const v2 = catalog(driftedV2Tools());
    expect(() => reconcileCatalogPins({ catalog: v2, agentDir })).toThrow(/catalog pins/i);
  });

  it("missing_pins_with_surviving_sig_names_files_loudly", () => {
    const agentDir = ackedV1AgentDir();
    const pinsPath = path.join(agentDir, "mcp-catalog-pins.json");
    fs.rmSync(pinsPath); // attacker/operator deleted the pins, .sig + .key survive
    expect(fs.existsSync(`${pinsPath}.sig`)).toBe(true);
    const v2 = catalog(driftedV2Tools());
    expect(() => reconcileCatalogPins({ catalog: v2, pinsPath })).toThrow(/\.sig/);
  });
});
