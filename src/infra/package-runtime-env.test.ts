import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPackageRuntimeEnv, resolvePackageRuntimeNpmCommand } from "./package-runtime-env.js";

describe("createPackageRuntimeEnv", () => {
  it("prepends the selected Node directory without mutating the caller env", () => {
    const env = { Path: "/usr/bin" };

    const result = createPackageRuntimeEnv(env, "/service/bin/node");

    expect(result?.Path?.split(path.delimiter)[0]).toBe("/service/bin");
    expect(result).not.toHaveProperty("PATH");
    expect(env).toEqual({ Path: "/usr/bin" });
  });

  it("leaves PATH unchanged for a non-absolute runtime command", () => {
    const env = { PATH: "/usr/bin" };

    expect(createPackageRuntimeEnv(env, "node")).toBe(env);
  });

  it("recognizes forward-slash Windows Node paths", () => {
    const result = createPackageRuntimeEnv(
      { Path: "C:\\Windows\\System32" },
      "C:/Program Files/nodejs/node.exe",
    );

    expect(result?.Path?.startsWith(`C:/Program Files/nodejs${path.delimiter}`)).toBe(true);
    expect(resolvePackageRuntimeNpmCommand("C:/Program Files/nodejs/node.exe")).toBe(
      "C:\\Program Files\\nodejs\\npm.cmd",
    );
  });
});
