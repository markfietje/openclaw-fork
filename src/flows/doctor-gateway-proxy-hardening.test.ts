// Doctor proxy-hardening warning (brain-server v1.28.88 gateway drill):
// behind a proxy (trustedProxies set) or bound beyond loopback (bind
// lan/custom) with all three verify-client hardening toggles off, Doctor
// must warn loudly naming the toggles + risk. Direct-local loopback with
// no proxy stays silent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "./doctor-health-contributions.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

const mocks = vi.hoisted(() => ({ note: vi.fn() }));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

function gatewayConfigContribution() {
  const contribution = resolveDoctorHealthContributions().find(
    (entry) => entry.id === "doctor:gateway-config",
  );
  if (!contribution) throw new Error("expected doctor contribution doctor:gateway-config");
  return contribution;
}

function hardeningNotes(): Array<{ message: string; title?: string }> {
  return mocks.note.mock.calls
    .map(([message, title]: [string, string?]) => ({ message, title }))
    .filter((entry) => entry.title === "Gateway proxy hardening");
}

function runGatewayHealth(gateway: OpenClawConfig["gateway"]) {
  const cfg = { gateway: { mode: "local", ...gateway } } as OpenClawConfig;
  const ctx = createDoctorHealthFlowContext({
    cfg,
    configResult: { cfg },
    configPath: "/tmp/fake-openclaw.json",
  });
  return runDoctorHealthContributionList(ctx, [gatewayConfigContribution()]);
}

describe("doctor gateway proxy hardening", () => {
  beforeEach(() => mocks.note.mockClear());

  it("warns behind a proxy with all three hardening toggles off", async () => {
    await runGatewayHealth({ trustedProxies: ["10.0.0.1"] });
    const notes = hardeningNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain("strictHeaderValidation");
    expect(notes[0]?.message).toContain("rejectUntrustedProxyHeaders");
    expect(notes[0]?.message).toContain("rejectCrossSiteWebSocketRequests");
    expect(notes[0]?.message).toMatch(/post-handshake/i);
  });

  it("warns on an exposed bind with all three hardening toggles off", async () => {
    await runGatewayHealth({ bind: "lan" });
    expect(hardeningNotes()).toHaveLength(1);
  });

  it("stays silent when all three toggles are on behind a proxy", async () => {
    await runGatewayHealth({
      trustedProxies: ["10.0.0.1"],
      security: {
        strictHeaderValidation: true,
        rejectUntrustedProxyHeaders: true,
        rejectCrossSiteWebSocketRequests: true,
      },
    });
    expect(hardeningNotes()).toHaveLength(0);
  });

  it("stays silent for direct-local loopback with no proxy", async () => {
    await runGatewayHealth({ bind: "loopback" });
    expect(hardeningNotes()).toHaveLength(0);
  });
});
