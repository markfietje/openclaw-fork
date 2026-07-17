import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { validateSecretsStatus } from "../index.js";
import { SecretsStatusSchema } from "./secrets.js";

describe("SecretsStatusSchema", () => {
  const validate = Compile(SecretsStatusSchema);

  it("accepts cold and stale degraded owners", () => {
    const status = {
      degraded: [
        {
          kind: "route",
          id: "webhooks/zapier",
          reason: "secret reference was not found",
          state: "cold",
          retryHint: "openclaw secrets reload",
          paths: ["plugins.entries.webhooks.config.routes.zapier.secret"],
        },
        {
          kind: "provider",
          id: "openai",
          reason: "secret provider failed",
          state: "stale",
          retryHint: "openclaw secrets reload",
          paths: ["models.providers.openai.apiKey"],
        },
      ],
    };
    expect(validate.Check(status)).toBe(true);
    expect(validateSecretsStatus(status)).toBe(true);
  });

  it("rejects unavailable legacy state and unknown fields", () => {
    const owner = {
      kind: "route",
      id: "webhooks/zapier",
      reason: "secret reference was not found",
      retryHint: "openclaw secrets reload",
      paths: [],
    };
    expect(validate.Check({ degraded: [{ ...owner, state: "unavailable" }] })).toBe(false);
    expect(validate.Check({ degraded: [{ ...owner, state: "cold", refKeys: ["private"] }] })).toBe(
      false,
    );
  });
});
