/** MCP catalog pins — tool + signer identity is pinned (v1.28.67 "Pin", audit X-M3).
 *
 * A malicious MCP server can change a tool's description or input schema
 * AFTER the operator approved it (the "rug pull", Invariant Labs 2025-04) —
 * openclaw materializes tools per RUN from a fresh catalog, so per-run
 * re-hash IS the per-execution cadence here (OWASP MCP Security Cheat Sheet
 * §2/§7 mapping). Every tool's definition is fingerprinted:
 *
 *   fp(tool) = sha256(toolName + \0 + description + \0 + stableStringify(normalizedSchema))
 *   catalogDigest(server) = sha256(sortedServerName + Σ fp in name order)
 *
 * and the acknowledged state lives in `mcp-catalog-pins.json` beside the
 * agent bundle (the agentDir discipline — NOT a secret; 0644). Drift
 * SURFACES to the operator (notification); it does not hard-block — no ack
 * UX exists yet, and first use is deliberately not gated (the ceiling is
 * stated here and in the changelog; tool shadowing remains a model-level
 * residual mitigated by args-visibility, not closed by this file).
 *
 * `ponytail:` no MCP registry / Transparency-log infrastructure and no
 * cross-host pin sharing — the pin is per-agent-bundle local state; multi-host
 * operators share config files as they already do. Revisit at real
 * federation.
 *
 * The pin file is the ACK state only: reconciliation never writes it, so a
 * drifted catalog keeps notifying until the operator acknowledges (a config
 * touch that records the current fingerprints). Corruption rebuilds LOUDLY
 * (every tool reads as new → all-new notifications), never silently.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeToolParameterSchema } from "@openclaw/ai/internal/tool-schema";
import { logWarn } from "../logger.js";
import type { McpCatalogTool, McpToolCatalog } from "./agent-bundle-mcp-types.js";

/** The pins file lives beside the agent bundle (agentDir discipline). */
export const CATALOG_PINS_FILENAME = "mcp-catalog-pins.json";

export type CatalogPinEntry = {
  catalogDigest: string;
  tools: Record<string, string>;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
};

export type CatalogPinsFile = Record<string, CatalogPinEntry>;

/** Deterministic JSON: sorted object keys, recursive. Schema normalize first
 * (the materialize path does), so key order from the server never matters.
 * Key ordering is a CODE-UNIT compare, never localeCompare: a locale-aware
 * collation reorders non-ASCII keys differently across ICU builds, which
 * would make the same catalog fingerprint differently on two machines —
 * permanent false drift. (Pinned by stable_stringify_is_icu_independent.) */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** fp(tool) = sha256(name + \0 + description + \0 + stableStringify(schema)).
 * The description feeds identity: a changed description IS drift even when
 * the schema is untouched (the description is what the model reads). */
export function fingerprintTool(params: {
  name: string;
  description: string;
  inputSchema: unknown;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      `${params.name}\u0000${params.description}\u0000${stableStringify(
        normalizeToolParameterSchema(params.inputSchema),
      )}`,
    )
    .digest("hex");
}

/** catalogDigest = sha256(sortedServerName + Σ fp in name order) — a server
 * whose tool set changes in ANY way changes digest. */
export function catalogDigest(serverName: string, fingerprints: Record<string, string>): string {
  const joined = Object.keys(fingerprints)
    .sort()
    .map((name) => `${name}\u0000${fingerprints[name]}`)
    .join("\u0001");
  return crypto.createHash("sha256").update(`${serverName}\u0000${joined}`).digest("hex");
}

/** The fingerprints of one server's catalog tools, keyed by the ORIGINAL
 * server-side tool name — display renames are not identity. */
export function fingerprintsForServer(tools: McpCatalogTool[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tool of tools) {
    out[tool.toolName] = fingerprintTool({
      name: tool.toolName,
      description: tool.description || tool.fallbackDescription,
      inputSchema: tool.inputSchema,
    });
  }
  return out;
}

/** Load the acknowledged pins. CORRUPTION IS LOUD: a file that does not
 * parse (or is not the expected shape) logs a warning and returns an EMPTY
 * pin set — every tool then reads as new and re-notifies, so a tampered or
 * truncated pin file can never silence drift. */
export function loadCatalogPins(pinsPath: string): CatalogPinsFile {
  let raw: string;
  try {
    raw = fs.readFileSync(pinsPath, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("pins root is not an object");
    }
    for (const [server, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`pins entry for "${server}" is not an object`);
      }
      const tools = (entry as CatalogPinEntry).tools;
      if (typeof tools !== "object" || tools === null) {
        throw new Error(`pins entry for "${server}" has no tools map`);
      }
    }
    return parsed as CatalogPinsFile;
  } catch (error) {
    logWarn(
      `bundle-mcp: catalog pins file "${pinsPath}" is corrupt (${String(error)}) — rebuilding LOUDLY: every tool will re-notify until acknowledged.`,
    );
    return {};
  }
}

/** Persist the acknowledged pins (0644 — operator-readable state, not a
 * secret; parent dir must exist — the agentDir discipline). */
export function saveCatalogPins(pinsPath: string, pins: CatalogPinsFile): void {
  fs.mkdirSync(path.dirname(pinsPath), { recursive: true });
  const tmp = `${pinsPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, pinsPath);
}

/** Acknowledge the CURRENT fingerprints of `catalog` for the named servers
 * (or every server when undefined) — the operator's config touch. The only
 * writer of drift-ending state. */
export function acknowledgeCatalogPins(params: {
  catalog: Pick<McpToolCatalog, "tools">;
  pinsPath: string;
  servers?: readonly string[];
  actor: string;
  now?: number;
}): void {
  const pins = loadCatalogPins(params.pinsPath);
  const byServer = new Map<string, McpCatalogTool[]>();
  for (const tool of params.catalog.tools) {
    const list = byServer.get(tool.serverName) ?? [];
    list.push(tool);
    byServer.set(tool.serverName, list);
  }
  for (const [serverName, tools] of byServer) {
    if (params.servers && !params.servers.includes(serverName)) {
      continue;
    }
    const fingerprints = fingerprintsForServer(tools);
    pins[serverName] = {
      catalogDigest: catalogDigest(serverName, fingerprints),
      tools: fingerprints,
      acknowledgedAt: params.now ?? Date.now(),
      acknowledgedBy: params.actor,
    };
  }
  saveCatalogPins(params.pinsPath, pins);
}

export type CatalogDrift = {
  serverName: string;
  /** Tools not in the acknowledged pins. */
  newTools: Array<{ name: string; description: string; fingerprint: string; pendingAck: true }>;
  /** Tools whose fingerprint moved (description or schema changed). */
  changedTools: Array<{
    name: string;
    description: string;
    previousFingerprint: string;
    fingerprint: string;
    pendingAck: true;
  }>;
  /** Acknowledged tools the server no longer lists. */
  removedTools: string[];
};

function diffServer(
  serverName: string,
  tools: McpCatalogTool[],
  acknowledged: CatalogPinEntry | undefined,
): CatalogDrift | undefined {
  const fingerprints = fingerprintsForServer(tools);
  const descriptions = new Map<string, string>(
    tools.map((tool) => [tool.toolName, tool.description || tool.fallbackDescription]),
  );
  const pinTools = acknowledged?.tools ?? {};
  const drift: CatalogDrift = {
    serverName,
    newTools: [],
    changedTools: [],
    removedTools: [],
  };
  for (const [name, fp] of Object.entries(fingerprints)) {
    const pinned = pinTools[name];
    if (pinned === undefined) {
      drift.newTools.push({
        name,
        fingerprint: fp,
        description: descriptions.get(name) ?? "",
        pendingAck: true,
      });
    } else if (pinned !== fp) {
      drift.changedTools.push({
        name,
        previousFingerprint: pinned,
        fingerprint: fp,
        description: descriptions.get(name) ?? "",
        pendingAck: true,
      });
    }
  }
  for (const name of Object.keys(pinTools)) {
    if (fingerprints[name] === undefined) {
      drift.removedTools.push(name);
    }
  }
  const empty =
    drift.newTools.length === 0 &&
    drift.changedTools.length === 0 &&
    drift.removedTools.length === 0;
  return empty ? undefined : drift;
}

/** Diff a fetched catalog against the acknowledged pins. Returns the drift
 * per server (empty map = everything matches, silent). Does NOT write the
 * pins file — acknowledgment is the operator's explicit touch. */
export function reconcileCatalogPins(params: {
  catalog: Pick<McpToolCatalog, "tools">;
  pinsPath?: string;
  notify?: (drift: CatalogDrift) => void;
}): Map<string, CatalogDrift> {
  const out = new Map<string, CatalogDrift>();
  if (!params.pinsPath) {
    return out;
  }
  const pins = loadCatalogPins(params.pinsPath);
  const byServer = new Map<string, McpCatalogTool[]>();
  for (const tool of params.catalog.tools) {
    const list = byServer.get(tool.serverName) ?? [];
    list.push(tool);
    byServer.set(tool.serverName, list);
  }
  // The diff universe is the UNION: a server that vanished (or now lists
  // nothing) must still surface its removed tools — grouping by catalog
  // tools alone would silence exactly the loudest disappearance.
  const serverNames = new Set<string>([...byServer.keys(), ...Object.keys(pins)]);
  for (const serverName of serverNames) {
    const drift = diffServer(serverName, byServer.get(serverName) ?? [], pins[serverName]);
    if (!drift) {
      continue;
    }
    out.set(serverName, drift);
    const notify = params.notify ?? defaultNotify;
    notify(drift);
  }
  return out;
}

function defaultNotify(drift: CatalogDrift): void {
  for (const tool of drift.newTools) {
    logWarn(
      `bundle-mcp catalog drift: NEW tool "${tool.name}" on server "${drift.serverName}" (${tool.description} — fp ${tool.fingerprint.slice(0, 12)}…) — pending operator ack`,
    );
  }
  for (const tool of drift.changedTools) {
    logWarn(
      `bundle-mcp catalog drift: tool "${tool.name}" on server "${drift.serverName}" CHANGED (${tool.description} — fp ${tool.previousFingerprint.slice(0, 12)}… → ${tool.fingerprint.slice(0, 12)}…) — pending operator ack`,
    );
  }
  for (const name of drift.removedTools) {
    logWarn(`bundle-mcp catalog drift: tool "${name}" REMOVED from server "${drift.serverName}"`);
  }
}

/** The set of drifted tool names per server — the materialize path uses it
 * to flag projected tools `pendingAck` in their plugin meta.
 * New (never-acknowledged) tools stay usable-but-flagged so first use is not
 * gated; see `changedToolNames` for the hard-blocked set. */
export function pendingAckToolNames(
  driftByServer: Map<string, CatalogDrift>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [serverName, drift] of driftByServer) {
    const names = new Set<string>([
      ...drift.newTools.map((t) => t.name),
      ...drift.changedTools.map((t) => t.name),
    ]);
    if (names.size > 0) {
      out.set(serverName, names);
    }
  }
  return out;
}

/** Tools whose fingerprint MOVED after acknowledgment (description or schema
 * changed post-approval — the rug pull). The materialize path hard-blocks
 * these until re-acknowledged; they are never projected. */
export function changedToolNames(
  driftByServer: Map<string, CatalogDrift>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [serverName, drift] of driftByServer) {
    const names = new Set<string>(drift.changedTools.map((t) => t.name));
    if (names.size > 0) {
      out.set(serverName, names);
    }
  }
  return out;
}
