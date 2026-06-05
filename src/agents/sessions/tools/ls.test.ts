// ls tool tests cover deterministic directory listings and safe limit
// normalization for agent-visible file enumeration.
import { describe, expect, it } from "vitest";
import { createLsToolDefinition, type LsOperations } from "./ls.js";

function operations(entries: string[]): LsOperations {
  return {
    exists: () => true,
    stat: (absolutePath) => ({
      isDirectory: () => absolutePath === "/workspace" || absolutePath.endsWith("/dir"),
    }),
    readdir: () => entries,
  };
}

function createHostileThrownValue(): unknown {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("property trap");
      },
      getPrototypeOf() {
        throw new Error("prototype trap");
      },
      ownKeys() {
        throw new Error("ownKeys trap");
      },
    },
  );
}

function textContent(
  result: Awaited<ReturnType<ReturnType<typeof createLsToolDefinition>["execute"]>>,
): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

describe("ls tool", () => {
  it("clamps non-positive limits instead of reporting a non-empty directory as empty", async () => {
    // Clamp to one entry so bad numeric input cannot hide directory contents.
    const tool = createLsToolDefinition("/workspace", {
      operations: operations(["beta.txt", "alpha.txt"]),
    });

    const result = await tool.execute("call-1", { limit: 0 }, undefined, undefined, {} as never);

    expect(textContent(result)).toBe(
      "alpha.txt\n\n[1 entries limit reached. Use limit=2 for more]",
    );
    expect(result.details?.entryLimitReached).toBe(1);
  });

  it("uses the default limit for non-finite values", async () => {
    const tool = createLsToolDefinition("/workspace", {
      operations: operations(["beta.txt", "alpha.txt"]),
    });

    const result = await tool.execute(
      "call-1",
      { limit: Number.NaN },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("alpha.txt\nbeta.txt");
    expect(result.details).toBeUndefined();
  });

  it("rejects hostile directory read failures without stringifying them", async () => {
    const tool = createLsToolDefinition("/workspace", {
      operations: {
        exists: () => true,
        stat: () => ({ isDirectory: () => true }),
        readdir: () => {
          throw createHostileThrownValue();
        },
      },
    });

    await expect(
      tool.execute("call-1", { path: "." }, undefined, undefined, {} as never),
    ).rejects.toThrow("Cannot read directory: Unknown error");
  });

  it("rejects hostile backend failures without retaining raw causes", async () => {
    const tool = createLsToolDefinition("/workspace", {
      operations: {
        exists: () => {
          throw createHostileThrownValue();
        },
        stat: () => ({ isDirectory: () => true }),
        readdir: () => [],
      },
    });

    await expect(
      tool.execute("call-1", { path: "." }, undefined, undefined, {} as never),
    ).rejects.toThrow("Ls tool error");
  });
});
