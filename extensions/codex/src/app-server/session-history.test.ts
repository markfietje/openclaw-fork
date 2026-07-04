// Codex tests cover mirrored session-history branch selection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function writeSession(records: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: "codex-session",
    timestamp: "2026-06-15T00:00:00.000Z",
    cwd: dir,
  };
  await fs.writeFile(
    sessionFile,
    [header, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return sessionFile;
}

// Fixtures keep legacy string content on purpose: session ingest normalizes
// assistant strings into [{ type: "text" }] blocks, so expectations below
// assert the canonical block-array shape for assistant rows.
function messageEntry(params: {
  id: string;
  parentId: string | null;
  role: "user" | "assistant";
  content: string;
  provenance?: { kind: "external_user" | "room_observation"; sourceChannel?: string };
}) {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: "2026-06-15T00:00:00.000Z",
    message: {
      role: params.role,
      content: params.content,
      timestamp: 1,
      ...(params.provenance ? { provenance: params.provenance } : {}),
    },
  };
}

function mirroredTarget(sessionFile: string) {
  return {
    sessionFile,
    sessionId: "codex-session",
    sessionKey: "codex-session",
  };
}

describe("readCodexMirroredSessionHistoryMessages", () => {
  it("replays only the branch selected by a leaf control", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "root", parentId: null, role: "user", content: "root prompt" }),
      messageEntry({
        id: "active",
        parentId: "root",
        role: "assistant",
        content: "active answer",
      }),
      messageEntry({
        id: "inactive",
        parentId: "root",
        role: "assistant",
        content: "inactive answer",
      }),
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive",
        targetId: "active",
      },
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toMatchObject([
      { role: "user", content: "root prompt" },
      { role: "assistant", content: [{ type: "text", text: "active answer" }] },
    ]);
  });

  it("honors explicit navigation to an empty branch", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "old", parentId: null, role: "user", content: "old prompt" }),
      {
        type: "leaf",
        id: "empty-leaf",
        parentId: "old",
        targetId: null,
        appendParentId: "old",
      },
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toEqual([]);
  });

  it("keeps visible history when continuation rows use a disjoint append cursor", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "visible", parentId: null, role: "user", content: "visible prompt" }),
      messageEntry({
        id: "inactive",
        parentId: "visible",
        role: "assistant",
        content: "inactive answer",
      }),
      {
        type: "metadata",
        id: "append-metadata",
        parentId: "inactive",
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive",
        targetId: "visible",
        appendParentId: "append-metadata",
      },
      messageEntry({
        id: "continued",
        parentId: "append-metadata",
        role: "assistant",
        content: "continued answer",
      }),
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toMatchObject([
      { role: "user", content: "visible prompt" },
      { role: "assistant", content: [{ type: "text", text: "continued answer" }] },
    ]);
  });

  it("keeps visible history when a continuation references the leaf marker", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "visible", parentId: null, role: "user", content: "visible prompt" }),
      messageEntry({
        id: "inactive",
        parentId: "visible",
        role: "assistant",
        content: "inactive answer",
      }),
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive",
        targetId: "visible",
      },
      messageEntry({
        id: "continued",
        parentId: "active-leaf",
        role: "assistant",
        content: "continued answer",
      }),
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toMatchObject([
      { role: "user", content: "visible prompt" },
      { role: "assistant", content: [{ type: "text", text: "continued answer" }] },
    ]);
  });

  it("excludes complete passive room turns from later authorized Codex history", async () => {
    const sessionFile = await writeSession([
      messageEntry({
        id: "passive-user",
        parentId: null,
        role: "user",
        content: "passive room instruction",
        provenance: { kind: "room_observation", sourceChannel: "slack" },
      }),
      messageEntry({
        id: "passive-assistant",
        parentId: "passive-user",
        role: "assistant",
        content: "passive room reply",
      }),
      messageEntry({
        id: "owner-user",
        parentId: "passive-assistant",
        role: "user",
        content: "authorized owner request",
        provenance: { kind: "external_user", sourceChannel: "slack" },
      }),
      messageEntry({
        id: "owner-assistant",
        parentId: "owner-user",
        role: "assistant",
        content: "authorized owner reply",
      }),
    ]);

    const history = await readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile));

    expect(history).toHaveLength(2);
    expect(history?.[0]).toMatchObject({
      role: "user",
      content: "authorized owner request",
      provenance: { kind: "external_user", sourceChannel: "slack" },
    });
    expect(history?.[1]).toMatchObject({ role: "assistant" });
    expect(JSON.stringify(history)).toContain("authorized owner reply");
    expect(JSON.stringify(history)).not.toContain("passive room");
  });
});
