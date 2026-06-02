import type { ModelCompatConfig } from "../config/types.models.js";
import { shouldOmitEmptyArrayItems } from "../plugins/provider-model-compat.js";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";

type ToolSchemaCompatInput = {
  unsupportedToolSchemaKeywords?: unknown;
  omitEmptyArrayItems?: unknown;
};

type ToolWithParameters = {
  name?: unknown;
  parameters: unknown;
};

const MAX_STRICT_SCHEMA_CACHE_ENTRIES_PER_SCHEMA = 8;
const MAX_OPENAI_STRICT_SCHEMA_ARRAY_ENTRIES = 10_000;
const OPENAI_STRICT_SCHEMA_INSPECTION_ERROR =
  "is not inspectable for OpenAI strict schema compatibility";
let strictOpenAISchemaCache = new WeakMap<object, Array<{ key: string; value: unknown }>>();

type StrictOpenAINormalizationResult = {
  readonly schema: unknown;
  readonly ok: boolean;
};

function resolveToolSchemaModelCompat(
  compat: ToolSchemaCompatInput | null | undefined,
): ModelCompatConfig | undefined {
  if (!compat) {
    return undefined;
  }
  const unsupportedToolSchemaKeywords = Array.isArray(compat.unsupportedToolSchemaKeywords)
    ? compat.unsupportedToolSchemaKeywords.filter(
        (keyword): keyword is string => typeof keyword === "string",
      )
    : [];
  if (unsupportedToolSchemaKeywords.length === 0 && compat.omitEmptyArrayItems !== true) {
    return undefined;
  }
  return {
    ...(unsupportedToolSchemaKeywords.length > 0 ? { unsupportedToolSchemaKeywords } : {}),
    ...(compat.omitEmptyArrayItems === true ? { omitEmptyArrayItems: true } : {}),
  };
}

function resolveStrictOpenAISchemaCacheKey(
  modelCompat: ToolSchemaCompatInput | null | undefined,
): string {
  const compat = resolveToolSchemaModelCompat(modelCompat);
  return JSON.stringify([
    [...(compat?.unsupportedToolSchemaKeywords ?? [])].toSorted(),
    shouldOmitEmptyArrayItems(compat),
  ]);
}

function readCachedStrictOpenAISchema(schema: object, key: string): unknown {
  return strictOpenAISchemaCache.get(schema)?.find((entry) => entry.key === key)?.value;
}

function rememberStrictOpenAISchema(schema: object, key: string, value: unknown): unknown {
  const entries = strictOpenAISchemaCache.get(schema) ?? [];
  strictOpenAISchemaCache.set(
    schema,
    [{ key, value }, ...entries.filter((entry) => entry.key !== key)].slice(
      0,
      MAX_STRICT_SCHEMA_CACHE_ENTRIES_PER_SCHEMA,
    ),
  );
  return value;
}

export function clearOpenAIToolSchemaCacheForTest(): void {
  strictOpenAISchemaCache = new WeakMap();
}

export function normalizeStrictOpenAIJsonSchema(
  schema: unknown,
  modelCompat?: ToolSchemaCompatInput | null,
): unknown {
  return normalizeStrictOpenAIJsonSchemaSafely(schema, modelCompat).schema;
}

function normalizeStrictOpenAIJsonSchemaSafely(
  schema: unknown,
  modelCompat?: ToolSchemaCompatInput | null,
): StrictOpenAINormalizationResult {
  const schemaInput = schema ?? {};
  if (!schemaInput || typeof schemaInput !== "object") {
    const normalizedInput = normalizeToolParameterSchemaSafely(schemaInput, modelCompat);
    const result = normalizeStrictOpenAIJsonSchemaRecursiveSafely(
      normalizedInput.schema,
      0,
      new WeakSet(),
    );
    return { schema: result.schema, ok: normalizedInput.ok && result.ok };
  }
  const cacheKey = resolveStrictOpenAISchemaCacheKey(modelCompat);
  const cached = readCachedStrictOpenAISchema(schemaInput, cacheKey);
  if (cached !== undefined) {
    return { schema: cached, ok: true };
  }
  const normalizedInput = normalizeToolParameterSchemaSafely(schemaInput, modelCompat);
  const result = normalizeStrictOpenAIJsonSchemaRecursiveSafely(
    normalizedInput.schema,
    0,
    new WeakSet(),
  );
  const safeResult = { schema: result.schema, ok: normalizedInput.ok && result.ok };
  if (safeResult.ok) {
    rememberStrictOpenAISchema(schemaInput, cacheKey, safeResult.schema);
  }
  return safeResult;
}

function normalizeToolParameterSchemaSafely(
  schema: unknown,
  modelCompat?: ToolSchemaCompatInput | null,
): StrictOpenAINormalizationResult {
  try {
    return {
      schema: normalizeToolParameterSchema(schema, {
        modelCompat: resolveToolSchemaModelCompat(modelCompat),
      }),
      ok: true,
    };
  } catch {
    return { schema: {}, ok: false };
  }
}

function normalizeStrictOpenAIJsonSchemaRecursiveSafely(
  schema: unknown,
  depth: number,
  activeObjects: WeakSet<object>,
): StrictOpenAINormalizationResult {
  if (Array.isArray(schema)) {
    if (activeObjects.has(schema)) {
      return { schema: [], ok: false };
    }
    activeObjects.add(schema);
    let length: number;
    try {
      length = schema.length;
    } catch {
      activeObjects.delete(schema);
      return { schema: [], ok: false };
    }
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_OPENAI_STRICT_SCHEMA_ARRAY_ENTRIES
    ) {
      activeObjects.delete(schema);
      return { schema: [], ok: false };
    }
    let ok = true;
    const normalized: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      let entry: unknown;
      try {
        entry = schema[index];
      } catch {
        normalized.push({});
        ok = false;
        continue;
      }
      const next = normalizeStrictOpenAIJsonSchemaRecursiveSafely(entry, depth, activeObjects);
      normalized.push(next.schema);
      ok &&= next.ok;
    }
    activeObjects.delete(schema);
    return { schema: normalized, ok };
  }
  if (!schema || typeof schema !== "object") {
    return { schema, ok: true };
  }
  if (activeObjects.has(schema)) {
    return { schema: {}, ok: false };
  }

  const record = schema as Record<string, unknown>;
  activeObjects.add(schema);
  let changed = false;
  let ok = true;
  const normalized: Record<string, unknown> = {};
  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(record);
  } catch {
    activeObjects.delete(schema);
    return { schema: {}, ok: false };
  }
  for (const [key, value] of entries) {
    const next = normalizeStrictOpenAIJsonSchemaRecursiveSafely(
      value,
      key === "properties" ? depth : depth + 1,
      activeObjects,
    );
    normalized[key] = next.schema;
    changed ||= next.schema !== value;
    ok &&= next.ok;
  }

  if (normalized.type === "object") {
    const properties =
      normalized.properties &&
      typeof normalized.properties === "object" &&
      !Array.isArray(normalized.properties)
        ? (normalized.properties as Record<string, unknown>)
        : undefined;
    const propertyKeys = properties ? readOpenAIStrictObjectKeys(properties) : undefined;
    if (propertyKeys && propertyKeys.length === 0 && !Array.isArray(normalized.required)) {
      normalized.required = [];
      changed = true;
    } else if (properties && !propertyKeys) {
      normalized.properties = {};
      ok = false;
      changed = true;
    }
    if (depth === 0 && !("additionalProperties" in normalized)) {
      normalized.additionalProperties = false;
      changed = true;
    }
  }

  activeObjects.delete(schema);
  return { schema: changed ? normalized : schema, ok };
}

function readOpenAIStrictObjectKeys(value: Record<string, unknown>): string[] | undefined {
  try {
    return Object.keys(value);
  } catch {
    return undefined;
  }
}

export function normalizeOpenAIStrictToolParameters<T>(
  schema: T,
  strict: boolean,
  modelCompat?: ToolSchemaCompatInput | null,
): T {
  const toolSchemaCompat = resolveToolSchemaModelCompat(modelCompat);
  if (!strict) {
    return normalizeToolParameterSchema(schema ?? {}, { modelCompat: toolSchemaCompat }) as T;
  }
  return normalizeStrictOpenAIJsonSchema(schema, toolSchemaCompat) as T;
}

export function isStrictOpenAIJsonSchemaCompatible(schema: unknown): boolean {
  const normalized = normalizeStrictOpenAIJsonSchemaSafely(schema);
  return normalized.ok && isStrictOpenAIJsonSchemaCompatibleRecursive(normalized.schema);
}

type OpenAIStrictToolSchemaDiagnostic = {
  toolIndex: number;
  toolName?: string;
  violations: string[];
};

export function findOpenAIStrictToolSchemaDiagnostics(
  tools: readonly ToolWithParameters[],
): OpenAIStrictToolSchemaDiagnostic[] {
  return readOpenAIStrictToolEntries(tools).flatMap((entry) => {
    if (!entry.readable) {
      return [
        {
          toolIndex: entry.toolIndex,
          violations: [`tool[${entry.toolIndex}] is unreadable`],
        },
      ];
    }
    const nameRead = readOpenAIStrictToolField(entry.tool, "name");
    const toolName =
      nameRead.readable && typeof nameRead.value === "string" && nameRead.value
        ? nameRead.value
        : `tool[${entry.toolIndex}]`;
    const descriptorViolations = nameRead.readable ? [] : [`${toolName}.name is unreadable`];
    const parametersRead = readOpenAIStrictToolField(entry.tool, "parameters");
    if (!parametersRead.readable) {
      return [
        {
          toolIndex: entry.toolIndex,
          ...(toolName ? { toolName } : {}),
          violations: [...descriptorViolations, `${toolName}.parameters is unreadable`],
        },
      ];
    }
    const schemaPath = `${toolName}.parameters`;
    const normalized = normalizeStrictOpenAIJsonSchemaSafely(parametersRead.value);
    const violations = [
      ...descriptorViolations,
      ...(normalized.ok ? [] : [`${schemaPath} ${OPENAI_STRICT_SCHEMA_INSPECTION_ERROR}`]),
      ...findStrictOpenAIJsonSchemaViolations(normalized.schema, schemaPath),
    ];
    if (violations.length === 0) {
      return [];
    }
    return [
      {
        toolIndex: entry.toolIndex,
        ...(toolName ? { toolName } : {}),
        violations,
      },
    ];
  });
}

function readOpenAIStrictToolEntries(
  tools: readonly ToolWithParameters[],
): Array<
  | { readonly readable: true; readonly tool: ToolWithParameters; readonly toolIndex: number }
  | { readonly readable: false; readonly toolIndex: number }
> {
  let length: number;
  try {
    length = tools.length;
  } catch {
    return [{ readable: false, toolIndex: 0 }];
  }
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_OPENAI_STRICT_SCHEMA_ARRAY_ENTRIES
  ) {
    return [{ readable: false, toolIndex: 0 }];
  }
  const entries: Array<
    | { readonly readable: true; readonly tool: ToolWithParameters; readonly toolIndex: number }
    | { readonly readable: false; readonly toolIndex: number }
  > = [];
  for (let toolIndex = 0; toolIndex < length; toolIndex += 1) {
    try {
      entries.push({ readable: true, tool: tools[toolIndex], toolIndex });
    } catch {
      entries.push({ readable: false, toolIndex });
    }
  }
  return entries;
}

function readOpenAIStrictToolField<TField extends keyof ToolWithParameters>(
  tool: ToolWithParameters,
  field: TField,
):
  | { readonly readable: true; readonly value: ToolWithParameters[TField] }
  | {
      readonly readable: false;
    } {
  try {
    return { readable: true, value: tool[field] };
  } catch {
    return { readable: false };
  }
}

function isStrictOpenAIJsonSchemaCompatibleRecursive(schema: unknown): boolean {
  if (Array.isArray(schema)) {
    return schema.every((entry) => isStrictOpenAIJsonSchemaCompatibleRecursive(entry));
  }
  if (!schema || typeof schema !== "object") {
    return true;
  }

  const record = schema as Record<string, unknown>;
  if ("anyOf" in record || "oneOf" in record || "allOf" in record) {
    return false;
  }
  if (Array.isArray(record.type)) {
    return false;
  }
  if (record.type === "object" && record.additionalProperties !== false) {
    return false;
  }
  if (record.type === "object") {
    const properties =
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (!required) {
      return false;
    }
    const requiredSet = new Set(required);
    if (Object.keys(properties).some((key) => !requiredSet.has(key))) {
      return false;
    }
  }

  return Object.entries(record).every(([key, entry]) => {
    if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.values(entry as Record<string, unknown>).every((value) =>
        isStrictOpenAIJsonSchemaCompatibleRecursive(value),
      );
    }
    return isStrictOpenAIJsonSchemaCompatibleRecursive(entry);
  });
}

function findStrictOpenAIJsonSchemaViolations(schema: unknown, path: string): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((entry, index) =>
      findStrictOpenAIJsonSchemaViolations(entry, `${path}[${index}]`),
    );
  }
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const record = schema as Record<string, unknown>;
  const violations: string[] = [];
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (key in record) {
      violations.push(`${path}.${key}`);
    }
  }
  if (Array.isArray(record.type)) {
    violations.push(`${path}.type`);
  }
  if (record.type === "object") {
    if (record.additionalProperties !== false) {
      violations.push(`${path}.additionalProperties`);
    }
    const properties =
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (!required) {
      violations.push(`${path}.required`);
    } else {
      const requiredSet = new Set(required);
      for (const key of Object.keys(properties)) {
        if (!requiredSet.has(key)) {
          violations.push(`${path}.required.${key}`);
        }
      }
    }
  }

  if (
    record.properties &&
    typeof record.properties === "object" &&
    !Array.isArray(record.properties)
  ) {
    for (const [key, value] of Object.entries(record.properties)) {
      violations.push(...findStrictOpenAIJsonSchemaViolations(value, `${path}.properties.${key}`));
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "properties") {
      continue;
    }
    if (value && typeof value === "object") {
      violations.push(...findStrictOpenAIJsonSchemaViolations(value, `${path}.${key}`));
    }
  }

  return violations;
}

export function resolveOpenAIStrictToolFlagForInventory(
  tools: readonly ToolWithParameters[],
  strict: boolean | null | undefined,
): boolean | undefined {
  if (strict !== true) {
    return strict === false ? false : undefined;
  }
  return findOpenAIStrictToolSchemaDiagnostics(tools).length === 0;
}
