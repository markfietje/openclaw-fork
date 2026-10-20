import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeHostExecEnv } from "./host-env-security.js";

/**
 * Application credentials that must never reach a host exec child.
 *
 * The gateway runs the exec tool as the same user that holds these secrets,
 * so a shell that inherits the gateway's environment inherits the credential
 * with it. The exec surface is also the one path the SSRF guard does not
 * cover: `web_fetch` refuses to reach `127.0.0.1:8765`, but a shell reaches
 * it directly. Blocking the names in the host env policy closes that route.
 */
const APPLICATION_SECRET_ENV_KEYS = [
  "BRAIN_SERVER_TOKEN",
  "BRAIN_AGENT_TOKEN",
  "BRAIN_AUTH_TOKEN",
  "BRAIN_BACKUP_PASSPHRASE",
  "OPENCLAW_GATEWAY_TOKEN",
];

describe("host exec env: application secrets", () => {
  it("drops every application secret from the inherited exec environment", () => {
    const baseEnv = Object.fromEntries(
      APPLICATION_SECRET_ENV_KEYS.map((key) => [key, "secret-value"]),
    );
    const env = sanitizeHostExecEnv({ baseEnv });
    for (const key of APPLICATION_SECRET_ENV_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("keeps unrelated inherited variables while dropping the secrets", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: { PATH: "/usr/bin", HOME: "/home/mark", BRAIN_SERVER_TOKEN: "secret-value" },
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/mark");
    expect(env.BRAIN_SERVER_TOKEN).toBeUndefined();
  });

  it("declares every application secret in the policy's blocked-everywhere list", () => {
    const policyPath = path.join(process.cwd(), "src", "infra", "host-env-security-policy.json");
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as {
      blockedEverywhereKeys?: string[];
    };
    const blocked = new Set((policy.blockedEverywhereKeys ?? []).map((key) => key.toUpperCase()));
    for (const key of APPLICATION_SECRET_ENV_KEYS) {
      expect(blocked.has(key.toUpperCase())).toBe(true);
    }
  });
});
