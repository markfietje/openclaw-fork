import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, type SecretRef } from "../config/types.secrets.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
import { isRecord } from "../shared/record-coerce.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type {
  PluginManifestCapabilityProviderAuthSignal,
  PluginManifestCapabilityProviderConfigSignal,
} from "./manifest.js";

type ToolMetadata = NonNullable<PluginManifestRecord["toolMetadata"]>[string];
export type ManifestConfigAvailabilitySignal = PluginManifestCapabilityProviderConfigSignal;
export type ManifestAuthAvailabilitySignal = PluginManifestCapabilityProviderAuthSignal;

type ReadValueResult = { ok: true; value: unknown } | { ok: false };
type ArrayCopyResult = { ok: true; entries: unknown[] } | { ok: false; entries: [] };
type StringArrayCopyResult = { ok: true; entries: string[] } | { ok: false; entries: [] };

function readRecordValueResult(record: unknown, key: string): ReadValueResult {
  if (!isRecord(record)) {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: record[key] };
  } catch {
    return { ok: false };
  }
}

function readRecordValue(record: unknown, key: string): unknown {
  const result = readRecordValueResult(record, key);
  return result.ok ? result.value : undefined;
}

function copyRecordEntries(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) {
    return [];
  }
  let keys: string[] = [];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  return keys.flatMap((key) => {
    try {
      return [[key, value[key]]];
    } catch {
      return [];
    }
  });
}

function copyRecord(value: unknown): Record<string, unknown> | undefined {
  const entries = copyRecordEntries(value);
  return entries.length > 0 ? Object.fromEntries(entries) : isRecord(value) ? {} : undefined;
}

function copyArrayEntriesResult(value: unknown): ArrayCopyResult {
  if (!Array.isArray(value)) {
    return { ok: true, entries: [] };
  }
  let length = 0;
  try {
    length = value.length;
  } catch {
    return { ok: false, entries: [] };
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      entries.push(value[index]);
    } catch {
      return { ok: false, entries: [] };
    }
  }
  return { ok: true, entries };
}

function copyArrayEntries(value: unknown): unknown[] {
  return copyArrayEntriesResult(value).entries;
}

function readArrayField(record: unknown, key: string): ArrayCopyResult {
  const result = readRecordValueResult(record, key);
  return result.ok ? copyArrayEntriesResult(result.value) : { ok: false, entries: [] };
}

function copyStringArrayEntries(value: unknown): string[] {
  return copyArrayEntries(value).filter((entry): entry is string => typeof entry === "string");
}

function readStringArrayField(record: unknown, key: string): StringArrayCopyResult {
  const result = readArrayField(record, key);
  return result.ok
    ? {
        ok: true,
        entries: result.entries.filter((entry): entry is string => typeof entry === "string"),
      }
    : { ok: false, entries: [] };
}

function readPath(root: unknown, path: string | undefined): unknown {
  if (!path?.trim()) {
    return root;
  }
  let current = root;
  for (const segment of path.split(".")) {
    const key = segment.trim();
    if (!key) {
      return undefined;
    }
    current = readRecordValue(current, key);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function readStringAtPath(root: unknown, path: string): string | undefined {
  return normalizeOptionalString(readPath(root, path));
}

function readEffectiveConfig(params: {
  config?: OpenClawConfig;
  rootPath: string;
  overlayPath?: string;
}): Record<string, unknown> | undefined {
  const root = readPath(params.config, params.rootPath);
  if (!isRecord(root)) {
    return undefined;
  }
  const overlay = readPath(root, params.overlayPath);
  if (!isRecord(overlay)) {
    return copyRecord(root);
  }
  return {
    ...copyRecord(root),
    ...copyRecord(overlay),
  };
}

function hasConfiguredSecretRefInConfigPath(params: {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  ref: SecretRef;
}): boolean {
  const providerConfig = readRecordValue(
    readRecordValue(readRecordValue(params.config, "secrets"), "providers"),
    params.ref.provider,
  );
  if (params.ref.source !== "env") {
    return Boolean(isRecord(providerConfig) && providerConfig.source === params.ref.source);
  }
  if (!providerConfig) {
    return params.ref.provider === resolveDefaultSecretProviderAlias(params.config ?? {}, "env");
  }
  if (!isRecord(providerConfig) || providerConfig.source !== "env") {
    return false;
  }
  const allowlist = readRecordValue(providerConfig, "allowlist");
  return copyStringArrayEntries(allowlist).length === 0
    ? allowlist === undefined
    : copyStringArrayEntries(allowlist).includes(params.ref.id);
}

function hasConfiguredValue(params: {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
}): boolean {
  const secretRef = coerceSecretRef(params.value, params.config?.secrets?.defaults);
  if (secretRef) {
    return (
      hasConfiguredSecretRefInConfigPath({
        config: params.config,
        env: params.env,
        ref: secretRef,
      }) &&
      (secretRef.source !== "env" || Boolean(params.env[secretRef.id]?.trim()))
    );
  }
  if (typeof params.value === "string") {
    return params.value.trim().length > 0;
  }
  if (Array.isArray(params.value)) {
    return params.value.length > 0;
  }
  if (isRecord(params.value)) {
    return copyRecordEntries(params.value).length > 0;
  }
  return params.value !== undefined && params.value !== null;
}

export function manifestConfigSignalPasses(params: {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  signal: ManifestConfigAvailabilitySignal;
}): boolean {
  const rootPathResult = readRecordValueResult(params.signal, "rootPath");
  if (!rootPathResult.ok) {
    return false;
  }
  const rootPath = rootPathResult.value;
  if (typeof rootPath !== "string") {
    return false;
  }
  const overlayPathResult = readRecordValueResult(params.signal, "overlayPath");
  if (!overlayPathResult.ok) {
    return false;
  }
  const effectiveConfig = readEffectiveConfig({
    config: params.config,
    rootPath,
    overlayPath: typeof overlayPathResult.value === "string" ? overlayPathResult.value : undefined,
  });
  if (!effectiveConfig) {
    return false;
  }
  const modeSignalResult = readRecordValueResult(params.signal, "mode");
  if (!modeSignalResult.ok) {
    return false;
  }
  const modeSignal = modeSignalResult.value;
  if (isRecord(modeSignal)) {
    const rawModePathResult = readRecordValueResult(modeSignal, "path");
    const rawDefaultResult = readRecordValueResult(modeSignal, "default");
    if (!rawModePathResult.ok || !rawDefaultResult.ok) {
      return false;
    }
    const rawModePath = rawModePathResult.value;
    const modePath = typeof rawModePath === "string" && rawModePath.trim() ? rawModePath : "mode";
    const rawDefault = rawDefaultResult.value;
    const mode =
      readStringAtPath(effectiveConfig, modePath) ??
      (typeof rawDefault === "string" ? rawDefault : undefined);
    if (!mode) {
      return false;
    }
    const allowedResult = readStringArrayField(modeSignal, "allowed");
    const disallowedResult = readStringArrayField(modeSignal, "disallowed");
    if (!allowedResult.ok || !disallowedResult.ok) {
      return false;
    }
    const allowed = allowedResult.entries;
    const disallowed = disallowedResult.entries;
    if (allowed.length > 0 && !allowed.includes(mode)) {
      return false;
    }
    if (disallowed.includes(mode)) {
      return false;
    }
  }
  const requiredResult = readStringArrayField(params.signal, "required");
  const requiredAnyResult = readStringArrayField(params.signal, "requiredAny");
  if (!requiredResult.ok || !requiredAnyResult.ok) {
    return false;
  }
  for (const requiredPath of requiredResult.entries) {
    if (
      !hasConfiguredValue({
        config: params.config,
        env: params.env,
        value: readPath(effectiveConfig, requiredPath),
      })
    ) {
      return false;
    }
  }
  const requiredAny = requiredAnyResult.entries;
  if (
    requiredAny.length > 0 &&
    !requiredAny.some((path) =>
      hasConfiguredValue({
        config: params.config,
        env: params.env,
        value: readPath(effectiveConfig, path),
      }),
    )
  ) {
    return false;
  }
  return true;
}

function normalizeBaseUrlForManifestGuard(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function manifestProviderBaseUrlGuardPasses(params: {
  config?: OpenClawConfig;
  guard: ManifestAuthAvailabilitySignal["providerBaseUrl"];
}): boolean {
  const guard = params.guard;
  if (!isRecord(guard)) {
    return true;
  }
  const provider = readRecordValue(guard, "provider");
  if (typeof provider !== "string") {
    return false;
  }
  const providerConfig = readRecordValue(
    readRecordValue(readRecordValue(params.config, "models"), "providers"),
    provider,
  );
  const baseUrl = readRecordValue(providerConfig, "baseUrl");
  const defaultBaseUrl = readRecordValue(guard, "defaultBaseUrl");
  const rawBaseUrl =
    typeof baseUrl === "string" && baseUrl.trim()
      ? baseUrl
      : typeof defaultBaseUrl === "string"
        ? defaultBaseUrl
        : undefined;
  if (!rawBaseUrl) {
    return false;
  }
  const normalizedBaseUrl = normalizeBaseUrlForManifestGuard(rawBaseUrl);
  return copyStringArrayEntries(readRecordValue(guard, "allowedBaseUrls")).some(
    (allowedBaseUrl) => normalizeBaseUrlForManifestGuard(allowedBaseUrl) === normalizedBaseUrl,
  );
}

export function manifestPluginSetupProviderEnvVars(
  plugin: PluginManifestRecord,
  providerId: string,
): readonly string[] {
  const directProvider = copyArrayEntries(
    readRecordValue(readRecordValue(plugin, "setup"), "providers"),
  )
    .filter(isRecord)
    .find((provider) => readRecordValue(provider, "id") === providerId);
  const direct = copyStringArrayEntries(readRecordValue(directProvider, "envVars"));
  if (direct.length > 0) {
    return direct;
  }
  return copyStringArrayEntries(
    readRecordValue(readRecordValue(plugin, "providerAuthEnvVars"), providerId),
  );
}

export function hasNonEmptyManifestEnvCandidate(
  env: NodeJS.ProcessEnv,
  envVars: readonly string[],
): boolean {
  return copyStringArrayEntries(envVars).some((envVar) => {
    const key = envVar.trim();
    return key.length > 0 && Boolean(env[key]?.trim());
  });
}

function listToolAuthSignals(metadata: ToolMetadata): {
  signals: ManifestAuthAvailabilitySignal[];
  unreadable: boolean;
} {
  const authSignalEntries = readArrayField(metadata, "authSignals");
  if (!authSignalEntries.ok) {
    return { signals: [], unreadable: true };
  }
  let unreadable = false;
  const authSignals = authSignalEntries.entries.filter(isRecord).flatMap((signal) => {
    const providerResult = readRecordValueResult(signal, "provider");
    const providerBaseUrlResult = readRecordValueResult(signal, "providerBaseUrl");
    if (!providerResult.ok || !providerBaseUrlResult.ok) {
      unreadable = true;
      return [];
    }
    const provider = providerResult.value;
    if (typeof provider !== "string") {
      return [];
    }
    const providerBaseUrl = providerBaseUrlResult.value as
      | ManifestAuthAvailabilitySignal["providerBaseUrl"]
      | undefined;
    return [{ provider, ...(providerBaseUrl ? { providerBaseUrl } : {}) }];
  });
  if (authSignals.length > 0) {
    return { signals: authSignals, unreadable };
  }
  const authProviders = readStringArrayField(metadata, "authProviders");
  const aliases = readStringArrayField(metadata, "aliases");
  if (!authProviders.ok || !aliases.ok) {
    return { signals: [], unreadable: true };
  }
  return {
    signals: [...authProviders.entries, ...aliases.entries].map((provider) => ({ provider })),
    unreadable,
  };
}

function toolMetadataPasses(params: {
  plugin: PluginManifestRecord;
  metadata: ToolMetadata;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  hasAuthForProvider?: (providerId: string) => boolean;
}): boolean {
  const authSignals = listToolAuthSignals(params.metadata);
  const configSignalEntries = readArrayField(params.metadata, "configSignals");
  const configSignals = configSignalEntries.entries.filter(
    (signal): signal is ManifestConfigAvailabilitySignal => isRecord(signal),
  );
  if (
    configSignals.length === 0 &&
    authSignals.signals.length === 0 &&
    configSignalEntries.ok &&
    !authSignals.unreadable
  ) {
    return true;
  }
  if (
    configSignals.some((signal) =>
      manifestConfigSignalPasses({
        config: params.config,
        env: params.env,
        signal,
      }),
    )
  ) {
    return true;
  }
  if (!configSignalEntries.ok || authSignals.unreadable) {
    return false;
  }
  for (const signal of authSignals.signals) {
    if (
      !manifestProviderBaseUrlGuardPasses({
        config: params.config,
        guard: readRecordValue(signal, "providerBaseUrl") as
          | ManifestAuthAvailabilitySignal["providerBaseUrl"]
          | undefined,
      })
    ) {
      continue;
    }
    const provider = readRecordValue(signal, "provider");
    if (typeof provider !== "string") {
      continue;
    }
    if (params.hasAuthForProvider?.(provider)) {
      return true;
    }
    if (
      hasNonEmptyManifestEnvCandidate(
        params.env,
        manifestPluginSetupProviderEnvVars(params.plugin, provider),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function hasManifestToolAvailability(params: {
  plugin: PluginManifestRecord;
  toolNames: readonly string[];
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  hasAuthForProvider?: (providerId: string) => boolean;
}): boolean {
  for (const toolName of copyStringArrayEntries(params.toolNames)) {
    const metadataMapResult = readRecordValueResult(params.plugin, "toolMetadata");
    if (!metadataMapResult.ok) {
      return false;
    }
    const metadataResult = readRecordValueResult(metadataMapResult.value, toolName);
    if (!metadataResult.ok) {
      continue;
    }
    const metadata = metadataResult.value;
    if (!metadata) {
      return true;
    }
    if (!isRecord(metadata)) {
      continue;
    }
    if (
      toolMetadataPasses({
        plugin: params.plugin,
        metadata,
        config: params.config,
        env: params.env,
        hasAuthForProvider: params.hasAuthForProvider,
      })
    ) {
      return true;
    }
  }
  return false;
}
