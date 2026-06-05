// CLI backend registration tests cover plugin-owned runtime snapshotting.
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCliBackendConfig, resolveCliBackendLiveTest } from "../../agents/cli-backends.js";
import { applyPluginTextReplacements } from "../../agents/plugin-text-transforms.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type {
  CliBackendPlugin,
  CliBackendPrepareExecutionContext,
  CliBackendResolveExecutionArgsContext,
  PluginTextReplacement,
} from "../types.js";

describe("plugin cli backend registration", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("snapshots backend fields before CLI backend resolution", async () => {
    let idReads = 0;
    let configReads = 0;
    let commandReads = 0;
    let modelProviderReads = 0;
    let liveTestReads = 0;
    let liveTestDefaultReads = 0;
    let capabilitiesReads = 0;
    let transformReads = 0;
    let prepareReads = 0;
    let resolveArgsReads = 0;
    let textTransformsReads = 0;
    let outputReads = 0;
    let outputFromReads = 0;
    let outputToReads = 0;
    const events: string[] = [];
    const outputReplacement = {
      get from() {
        outputFromReads += 1;
        if (outputFromReads > 1) {
          throw new Error("backend output from getter re-read");
        }
        return "raw";
      },
      get to() {
        outputToReads += 1;
        if (outputToReads > 1) {
          throw new Error("backend output to getter re-read");
        }
        return "clean";
      },
    } as PluginTextReplacement;
    const transformSystemPrompt: NonNullable<CliBackendPlugin["transformSystemPrompt"]> = function (
      this: { marker?: string },
      ctx,
    ) {
      events.push(`transform:${this.marker ?? "missing"}`);
      return `${this.marker}:${ctx.systemPrompt}`;
    };
    const prepareExecution: NonNullable<CliBackendPlugin["prepareExecution"]> = function (
      this: { marker?: string },
      ctx: CliBackendPrepareExecutionContext,
    ) {
      events.push(`prepare:${this.marker ?? "missing"}:${ctx.provider}`);
      return { env: { MARKER: this.marker ?? "missing" } };
    };
    const resolveExecutionArgs: NonNullable<CliBackendPlugin["resolveExecutionArgs"]> = function (
      this: { marker?: string },
      ctx: CliBackendResolveExecutionArgsContext,
    ) {
      events.push(`args:${this.marker ?? "missing"}:${ctx.provider}`);
      return [...ctx.baseArgs, "--marker", this.marker ?? "missing"];
    };
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "volatile-cli-plugin",
        name: "Volatile CLI Plugin",
      }),
      register(api) {
        api.registerCliBackend({
          marker: "original",
          get id() {
            idReads += 1;
            if (idReads > 1) {
              throw new Error("backend id getter re-read");
            }
            return " volatile-cli ";
          },
          get modelProvider() {
            modelProviderReads += 1;
            if (modelProviderReads > 1) {
              throw new Error("backend modelProvider getter re-read");
            }
            return "openai";
          },
          get config() {
            configReads += 1;
            if (configReads > 1) {
              throw new Error("backend config getter re-read");
            }
            return {
              get command() {
                commandReads += 1;
                if (commandReads > 1) {
                  throw new Error("backend config command getter re-read");
                }
                return "volatile-bin";
              },
              args: ["run"],
            } as CliBackendConfig;
          },
          get liveTest() {
            liveTestReads += 1;
            if (liveTestReads > 1) {
              throw new Error("backend liveTest getter re-read");
            }
            return {
              get defaultModelRef() {
                liveTestDefaultReads += 1;
                if (liveTestDefaultReads > 1) {
                  throw new Error("backend liveTest default getter re-read");
                }
                return "volatile-cli/model";
              },
            };
          },
          get contextEngineHostCapabilities() {
            capabilitiesReads += 1;
            if (capabilitiesReads > 1) {
              throw new Error("backend capabilities getter re-read");
            }
            return ["compact"];
          },
          get transformSystemPrompt() {
            transformReads += 1;
            if (transformReads > 1) {
              throw new Error("backend transform getter re-read");
            }
            return transformSystemPrompt;
          },
          get textTransforms() {
            textTransformsReads += 1;
            if (textTransformsReads > 1) {
              throw new Error("backend textTransforms getter re-read");
            }
            return {
              get output() {
                outputReads += 1;
                if (outputReads > 1) {
                  throw new Error("backend output replacements getter re-read");
                }
                return [outputReplacement];
              },
            };
          },
          get prepareExecution() {
            prepareReads += 1;
            if (prepareReads > 1) {
              throw new Error("backend prepare getter re-read");
            }
            return prepareExecution;
          },
          get resolveExecutionArgs() {
            resolveArgsReads += 1;
            if (resolveArgsReads > 1) {
              throw new Error("backend args getter re-read");
            }
            return resolveExecutionArgs;
          },
        } as CliBackendPlugin & { marker: string });
      },
    });
    expect(registry.registry.diagnostics).toEqual([]);
    expect(registry.registry.cliBackends?.[0]?.backend.modelProvider).toBe("openai");
    setActivePluginRegistry(registry.registry);

    const resolved = resolveCliBackendConfig("volatile-cli", {} as OpenClawConfig);
    const liveTest = resolveCliBackendLiveTest("volatile-cli");

    expect(resolved?.modelProvider).toBe("openai");
    expect(resolved?.config.command).toBe("volatile-bin");
    expect(resolved?.contextEngineHostCapabilities).toEqual(["compact"]);
    expect(liveTest?.defaultModelRef).toBe("volatile-cli/model");
    expect(
      resolved?.transformSystemPrompt?.({
        provider: "volatile-cli",
        modelId: "model",
        modelDisplay: "model",
        systemPrompt: "prompt",
      }),
    ).toBe("original:prompt");
    await expect(
      Promise.resolve(
        resolved?.prepareExecution?.({
          workspaceDir: "workspace",
          provider: "volatile-cli",
          modelId: "model",
        }),
      ),
    ).resolves.toEqual({ env: { MARKER: "original" } });
    expect(
      resolved?.resolveExecutionArgs?.({
        workspaceDir: "workspace",
        provider: "volatile-cli",
        modelId: "model",
        useResume: false,
        baseArgs: ["base"],
      }),
    ).toEqual(["base", "--marker", "original"]);
    expect(applyPluginTextReplacements("raw output", resolved?.textTransforms?.output)).toBe(
      "clean output",
    );
    expect(events).toEqual([
      "transform:original",
      "prepare:original:volatile-cli",
      "args:original:volatile-cli",
    ]);
    expect(idReads).toBe(1);
    expect(configReads).toBe(1);
    expect(commandReads).toBe(1);
    expect(modelProviderReads).toBe(1);
    expect(liveTestReads).toBe(1);
    expect(liveTestDefaultReads).toBe(1);
    expect(capabilitiesReads).toBe(1);
    expect(transformReads).toBe(1);
    expect(prepareReads).toBe(1);
    expect(resolveArgsReads).toBe(1);
    expect(textTransformsReads).toBe(1);
    expect(outputReads).toBe(1);
    expect(outputFromReads).toBe(1);
    expect(outputToReads).toBe(1);
  });
});
