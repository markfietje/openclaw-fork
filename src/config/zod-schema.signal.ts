import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { z } from "zod";
import { ExecutableTokenSchema } from "./zod-schema.core.js";

function hasNoUrlCredentials(value: string): boolean {
  try {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

const SignalTransportUrlSchema = z
  .string()
  .url()
  .refine(isHttpUrl, "Expected http:// or https:// URL")
  .refine(hasNoUrlCredentials, "Signal transport URL must not include credentials");

export const SignalTransportSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("managed-native"),
      configPath: z.string().optional(),
      httpHost: z.string().optional(),
      httpPort: z.number().int().positive().optional(),
      cliPath: ExecutableTokenSchema.optional(),
      startupTimeoutMs: z.number().int().min(1000).max(120000).optional(),
      receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
      ignoreStories: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external-native"),
      url: SignalTransportUrlSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("container"),
      url: SignalTransportUrlSchema,
    })
    .strict(),
]);
