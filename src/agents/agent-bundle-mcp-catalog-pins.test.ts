/** Tests for MCP catalog pins (v1.28.67 "Pin", X-M3): fingerprinting,
 * drift surfacing, ack silence, loud corruption rebuild. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeCatalogPins,
  catalogDigest,
  fingerprintTool,
  loadCatalogPins,
  reconcileCatalogPins,
  stableStringify,
  type CatalogDrift,
} from "./agent-bundle-mcp-catalog-pins.js";
import type { McpCatalogTool } from "./agent-bundle-mcp-types.js";

function tool(overrides: Partial<McpCatalogTool> & { toolName: string }): McpCatalogTool {
  return {
    serverName: "probe",
    safeServerName: "probe",
    fallbackDescription: `${overrides.toolName} fallback`,
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  } as McpCatalogTool;
}

function pinsPath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pins-")),
    "mcp-catalog-pins.json",
  );
}

const notifications: CatalogDrift[] = [];
const notify = (drift: CatalogDrift) => {
  notifications.push(drift);
};
afterEach(() => {
  notifications.length = 0;
});

function driftFor(server: string): CatalogDrift {
  const drift = notifications.find((d) => d.serverName === server);
  expect(drift, `expected drift for ${server}`).toBeDefined();
  return drift as CatalogDrift;
}

describe("mcp catalog pins", () => {
  it("catalog_fingerprint_stable_across_runs", () => {
    const fp = () =>
      fingerprintTool({
        name: "search",
        description: "search the web",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      });
    expect(fp()).toBe(fp());
    // Key ORDER inside the schema must not move the fingerprint
    // (stableStringify sorts keys; servers re-serialize per run).
    expect(
      fingerprintTool({
        name: "search",
        description: "search the web",
        inputSchema: { properties: { q: { type: "string" } }, type: "object" },
      }),
    ).toBe(fp());
    // …but ANY content change does.
    expect(
      fingerprintTool({
        name: "search",
        description: "search the web!",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      }),
    ).not.toBe(fp());
    // stableStringify is deterministic on nested structures.
    expect(stableStringify({ b: 2, a: { d: [1, { c: 3 }] } })).toBe(
      stableStringify({ a: { d: [1, { c: 3 }] }, b: 2 }),
    );
  });

  // Key ordering is CODE-UNIT compare, never locale-aware collation: an ICU
  // build difference would fingerprint the same catalog differently on two
  // machines — permanent false drift. The exact expected serialization pins
  // the collation (localeCompare would reorder é/Z/_ differently).
  it("stable_stringify_is_icu_independent", () => {
    expect(stableStringify({ é: 1, Z: 2, a: 3, _: 4 })).toBe('{"Z":2,"_":4,"a":3,"\u00e9":1}');
  });

  it("forged_pins_rebuild_loudly", () => {
    const target = pinsPath();
    const catalog = {
      version: 1,
      generatedAt: 1,
      servers: {},
      tools: [tool({ toolName: "search", description: "search the web" })],
    };
    acknowledgeCatalogPins({ catalog, pinsPath: target, actor: "operator", now: 1 });
    // Attacker with file write re-pins a forged fingerprint set by hand.
    fs.writeFileSync(target, JSON.stringify({ probe: { catalogDigest: "x", tools: {} } }));
    const pins = loadCatalogPins(target);
    expect(pins).toEqual({});
  });

  it("unsigned_legacy_pins_rebuild_loudly_then_resign", () => {
    const target = pinsPath();
    fs.writeFileSync(target, JSON.stringify({ probe: { catalogDigest: "x", tools: {} } }));
    expect(loadCatalogPins(target)).toEqual({});
    const catalog = {
      version: 1,
      generatedAt: 1,
      servers: {},
      tools: [tool({ toolName: "search", description: "search the web" })],
    };
    acknowledgeCatalogPins({ catalog, pinsPath: target, actor: "operator", now: 1 });
    expect(Object.keys(loadCatalogPins(target))).toEqual(["probe"]);
  });

  it("description_change_surfaces_drift", () => {
    const target = pinsPath();
    const first = {
      version: 1,
      generatedAt: 1,
      servers: {},
      tools: [tool({ toolName: "search", description: "search the web" })],
    };
    reconcileCatalogPins({ catalog: first, pinsPath: target, notify });
    // First sight: every tool is new (no pins yet) — surfaced.
    expect(driftFor("probe").newTools.map((t) => t.name)).toEqual(["search"]);

    // Acknowledge run-one state, then RUG PULL: the server mutates the
    // description between runs.
    acknowledgeCatalogPins({ catalog: first, pinsPath: target, actor: "operator", now: 1 });
    const pulled = {
      version: 1,
      generatedAt: 2,
      servers: {},
      tools: [tool({ toolName: "search", description: "TOTALLY LEGITIMATE search (trust me)" })],
    };
    notifications.length = 0;
    reconcileCatalogPins({ catalog: pulled, pinsPath: target, notify });
    const drift = driftFor("probe");
    expect(drift.newTools).toEqual([]);
    expect(drift.changedTools).toHaveLength(1);
    expect(drift.changedTools[0].name).toBe("search");
    expect(drift.changedTools[0].previousFingerprint).not.toBe(drift.changedTools[0].fingerprint);
    expect(drift.changedTools[0].pendingAck).toBe(true);
  });

  it("schema_change_surfaces_drift", () => {
    const target = pinsPath();
    const before = {
      version: 1,
      generatedAt: 1,
      servers: {},
      tools: [
        tool({
          toolName: "run",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
        }),
      ],
    };
    acknowledgeCatalogPins({ catalog: before, pinsPath: target, actor: "operator", now: 1 });
    const after = {
      version: 1,
      generatedAt: 2,
      servers: {},
      tools: [
        tool({
          toolName: "run",
          inputSchema: {
            type: "object",
            properties: { cmd: { type: "string" }, cwd: { type: "string" } },
            required: ["cmd"],
          },
        }),
      ],
    };
    reconcileCatalogPins({ catalog: after, pinsPath: target, notify });
    expect(driftFor("probe").changedTools.map((t) => t.name)).toEqual(["run"]);
  });

  it("new_tool_pending_ack_notifies", () => {
    const target = pinsPath();
    const before = {
      version: 1,
      generatedAt: 1,
      servers: {},
      tools: [tool({ toolName: "search" })],
    };
    acknowledgeCatalogPins({ catalog: before, pinsPath: target, actor: "operator", now: 1 });
    // The server lists an EXTRA tool the operator never acknowledged.
    const after = {
      version: 1,
      generatedAt: 2,
      servers: {},
      tools: [
        tool({ toolName: "search" }),
        tool({ toolName: "exfiltrate_notes", description: "harmless-looking" }),
      ],
    };
    reconcileCatalogPins({ catalog: after, pinsPath: target, notify });
    const drift = driftFor("probe");
    expect(drift.newTools.map((t) => t.name)).toEqual(["exfiltrate_notes"]);
    expect(drift.newTools[0].pendingAck).toBe(true);
    // Removed tools surface too — but only ACKNOWLEDGED tools can be
    // "removed": exfiltrate_notes was never acked, so it simply stops
    // appearing (search, the acked one, is the loss that surfaces).
    const gone = { version: 1, generatedAt: 3, servers: {}, tools: [] };
    notifications.length = 0;
    reconcileCatalogPins({ catalog: gone, pinsPath: target, notify });
    expect(driftFor("probe").removedTools).toEqual(["search"]);
  });

  it("acked_catalog_is_silent", () => {
    const target = pinsPath();
    const catalog = {
      version: 1,
      generatedAt: 1,
      servers: {},
      tools: [tool({ toolName: "search", description: "search the web" })],
    };
    reconcileCatalogPins({ catalog, pinsPath: target, notify });
    notifications.length = 0;
    // Acknowledge (the operator's config touch)…
    acknowledgeCatalogPins({ catalog, pinsPath: target, actor: "operator", now: 42 });
    // …and the SAME catalog re-materializes silently, run after run.
    reconcileCatalogPins({ catalog, pinsPath: target, notify });
    reconcileCatalogPins({ catalog: { ...catalog, generatedAt: 9 }, pinsPath: target, notify });
    expect(notifications).toEqual([]);
    // The ack is recorded on the pins entry.
    const pins = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(pins.probe.acknowledgedAt).toBe(42);
    expect(pins.probe.acknowledgedBy).toBe("operator");
  });

  it("rename_collision_pins_original_name", () => {
    // A colliding display rename is a MATERIALIZE concern, not identity:
    // the fingerprint binds the ORIGINAL server-side tool name.
    const original = fingerprintTool({ name: "fetch", description: "d", inputSchema: {} });
    const renamed = fingerprintTool({ name: "fetch_2", description: "d", inputSchema: {} });
    expect(original).not.toBe(renamed);
    // The catalog-side fingerprints (what reconcile uses) key by toolName —
    // two catalog tools that WOULD collide on display still pin distinctly.
    const tools = [
      tool({ toolName: "fetch", serverName: "a", safeServerName: "a" }),
      tool({ toolName: "fetch", serverName: "b", safeServerName: "b" }),
    ];
    const fpA = fingerprintTool({
      name: "fetch",
      description: "fetch fallback",
      inputSchema: tools[0].inputSchema,
    });
    expect(tools.every((t) => t.toolName === "fetch")).toBe(true);
    // Server-qualified digests never collide either.
    expect(catalogDigest("a", { fetch: fpA })).not.toBe(catalogDigest("b", { fetch: fpA }));
  });

  it("pin_file_corrupt_rebuilds_loudly", () => {
    const target = pinsPath();
    const catalog = {
      version: 1,
      generatedAt: 1,
      servers: {},
      tools: [tool({ toolName: "search" })],
    };
    acknowledgeCatalogPins({ catalog, pinsPath: target, actor: "operator", now: 1 });
    // Corrupt the file: valid JSON, wrong shape.
    fs.writeFileSync(target, '{"probe": "not-an-entry"}');
    reconcileCatalogPins({ catalog, pinsPath: target, notify });
    // The acked tool reads as NEW — corruption never silences drift.
    expect(driftFor("probe").newTools.map((t) => t.name)).toEqual(["search"]);
    // Worse: not JSON at all.
    fs.writeFileSync(target, "{{{ nope");
    notifications.length = 0;
    reconcileCatalogPins({ catalog, pinsPath: target, notify });
    expect(driftFor("probe").newTools).toHaveLength(1);
    // The corrupted file never passes silently: load returns an EMPTY pin
    // set (loud rebuild), so re-acknowledging repairs it.
    expect(Object.keys(loadCatalogPins(target))).toEqual([]);
    acknowledgeCatalogPins({ catalog, pinsPath: target, actor: "operator", now: 2 });
    notifications.length = 0;
    reconcileCatalogPins({ catalog, pinsPath: target, notify });
    expect(notifications).toEqual([]);
  });
});
