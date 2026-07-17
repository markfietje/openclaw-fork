import { Compile } from "typebox/compile";
import { describe, expect, expectTypeOf, it } from "vitest";
import { validateSecretsStatus } from "../index.js";
import { type SecretsDegradedOwner, SecretsStatusSchema } from "./secrets.js";

describe("SecretsStatusSchema", () => {
  const validate = Compile(SecretsStatusSchema);

  it("keeps owner kind and state closed in the static contract", () => {
    expectTypeOf<SecretsDegradedOwner["kind"]>().toEqualTypeOf<
      "account" | "capability" | "gateway" | "provider" | "route" | "unknown"
    >();
    expectTypeOf<SecretsDegradedOwner["state"]>().toEqualTypeOf<"cold" | "stale">();
  });

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
