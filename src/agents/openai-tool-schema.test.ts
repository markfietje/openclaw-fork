import { beforeEach, describe, expect, it } from "vitest";
import {
  clearOpenAIToolSchemaCacheForTest,
  findOpenAIStrictToolSchemaDiagnostics,
  isStrictOpenAIJsonSchemaCompatible,
  normalizeStrictOpenAIJsonSchema,
  resolveOpenAIStrictToolFlagForInventory,
} from "./openai-tool-schema.js";

describe("OpenAI strict tool schema normalization", () => {
  beforeEach(() => {
    clearOpenAIToolSchemaCacheForTest();
  });

  it("repairs top-level object schemas with missing or invalid properties", () => {
    const schemas = [
      { type: "object" },
      { type: "object", properties: undefined },
      { type: "object", properties: null },
      { type: "object", properties: [] },
      { type: "object", properties: "invalid" },
    ];

    for (const schema of schemas) {
      expect(normalizeStrictOpenAIJsonSchema(schema)).toEqual({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      });
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
      expect(
        resolveOpenAIStrictToolFlagForInventory([{ name: "empty", parameters: schema }], true),
      ).toBe(true);
    }
  });

  it("does not close permissive nested object schemas implicitly", () => {
    const schema = {
      type: "object",
      properties: {
        metadata: {
          type: "object",
        },
      },
      required: ["metadata"],
    };

    const normalized = normalizeStrictOpenAIJsonSchema(schema) as {
      additionalProperties?: boolean;
      properties?: { metadata?: { additionalProperties?: boolean } };
    };

    expect(normalized.additionalProperties).toBe(false);
    expect(normalized.properties?.metadata).not.toHaveProperty("additionalProperties");
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
    expect(
      resolveOpenAIStrictToolFlagForInventory([{ name: "write", parameters: schema }], true),
    ).toBe(false);
  });

  it("normalizes truly empty MCP tool schema {} for strict mode", () => {
    const schema = {};
    const normalized = normalizeStrictOpenAIJsonSchema(schema) as Record<string, unknown>;
    expect(normalized.type).toBe("object");
    expect(normalized.properties).toStrictEqual({});
    expect(normalized.required).toStrictEqual([]);
    expect(normalized.additionalProperties).toBe(false);
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
  });

  it("reuses normalized strict schemas for stable tool schema objects", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    };

    const first = normalizeStrictOpenAIJsonSchema(schema);
    const second = normalizeStrictOpenAIJsonSchema(schema);
    const third = normalizeStrictOpenAIJsonSchema(schema, {
      unsupportedToolSchemaKeywords: ["minimum"],
    });

    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(
      normalizeStrictOpenAIJsonSchema(schema, {
        unsupportedToolSchemaKeywords: ["minimum"],
      }),
    ).toBe(third);
  });

  it("reports circular strict schemas without recursing forever", () => {
    const schema: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: false;
    } = {
      type: "object",
      properties: {},
      required: ["self"],
      additionalProperties: false,
    };
    schema.properties.self = schema;

    expect(() => normalizeStrictOpenAIJsonSchema(schema)).not.toThrow();
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
    expect(findOpenAIStrictToolSchemaDiagnostics([{ name: "cycle", parameters: schema }])).toEqual([
      {
        toolIndex: 0,
        toolName: "cycle",
        violations: ["cycle.parameters is not inspectable for OpenAI strict schema compatibility"],
      },
    ]);
    expect(
      resolveOpenAIStrictToolFlagForInventory([{ name: "cycle", parameters: schema }], true),
    ).toBe(false);
  });

  it("reports hostile properties maps without throwing", () => {
    const hostileProperties = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("strict schema properties ownKeys exploded");
        },
      },
    );
    const schema = {
      type: "object",
      properties: hostileProperties,
      required: [],
      additionalProperties: false,
    };

    expect(() => normalizeStrictOpenAIJsonSchema(schema)).not.toThrow();
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
    expect(
      findOpenAIStrictToolSchemaDiagnostics([{ name: "hostile", parameters: schema }]),
    ).toEqual([
      {
        toolIndex: 0,
        toolName: "hostile",
        violations: [
          "hostile.parameters is not inspectable for OpenAI strict schema compatibility",
        ],
      },
    ]);
  });

  it("reports circular schema arrays without recursing forever", () => {
    const enumValues: unknown[] = [];
    enumValues.push(enumValues);
    const schema = {
      type: "object",
      properties: {
        choice: { type: "string", enum: enumValues },
      },
      required: ["choice"],
      additionalProperties: false,
    };

    expect(() => normalizeStrictOpenAIJsonSchema(schema)).not.toThrow();
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
    expect(
      findOpenAIStrictToolSchemaDiagnostics([{ name: "circular_enum", parameters: schema }]),
    ).toEqual([
      {
        toolIndex: 0,
        toolName: "circular_enum",
        violations: [
          "circular_enum.parameters is not inspectable for OpenAI strict schema compatibility",
        ],
      },
    ]);
  });

  it("normalizes schema arrays before strict compatibility walkers inspect them", () => {
    const required = new Proxy(["path"], {
      get(target, property, receiver) {
        if (property === "filter") {
          throw new Error("source required.filter should not be used");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const schema = {
      type: "object",
      properties: { path: { type: "string" } },
      required,
      additionalProperties: false,
    };

    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
    expect(findOpenAIStrictToolSchemaDiagnostics([{ name: "read", parameters: schema }])).toEqual(
      [],
    );
  });

  it("does not trust source tool array traversal methods", () => {
    const healthy = {
      name: "healthy",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    };
    const tools = new Proxy([healthy], {
      get(target, property, receiver) {
        if (property === "every" || property === "flatMap") {
          throw new Error(`source ${property} should not be used`);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(resolveOpenAIStrictToolFlagForInventory(tools, true)).toBe(true);
    expect(findOpenAIStrictToolSchemaDiagnostics(tools)).toEqual([]);
  });

  it("reports unreadable tool schemas before strict compatibility checks", () => {
    const tool = {
      name: "fuzzplugin_unreadable",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    };
    Object.defineProperty(tool, "parameters", {
      enumerable: true,
      get() {
        throw new Error("strict schema parameters getter exploded");
      },
    });

    expect(resolveOpenAIStrictToolFlagForInventory([tool], true)).toBe(false);
    expect(findOpenAIStrictToolSchemaDiagnostics([tool])).toEqual([
      {
        toolIndex: 0,
        toolName: "fuzzplugin_unreadable",
        violations: ["fuzzplugin_unreadable.parameters is unreadable"],
      },
    ]);
  });
});
