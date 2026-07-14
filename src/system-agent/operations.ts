// OpenClaw operations parse, approve, execute, and audit setup-helper commands.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ConfigSetOptions } from "../cli/config-set-input.js";
import type { DoctorOptions } from "../commands/doctor.types.js";
import { isSensitiveConfigPath } from "../config/sensitive-paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TuiResult } from "../tui/tui-types.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { isReservedSystemAgentId } from "./agent-id.js";
import { appendSystemAgentAuditEntry, resolveSystemAgentAuditPath } from "./audit.js";
import {
  projectDefaultInferenceRoute,
  sameDefaultInferenceRoute,
  type DefaultInferenceRouteProjection,
} from "./inference-route.js";
import type { SystemAgentOverview } from "./overview.js";
import { validateSystemAgentPluginInstallSpec } from "./plugin-install.js";

export { parseSystemAgentOperation } from "./operations-parser.js";

/**
 * OpenClaw command parser and operation executor.
 *
 * The grammar is a single anchored command language: every pattern must match
 * the whole input. Natural language never parses into an operation — it flows
 * to the system agent instead (chat) or to the planner (one-shot). This is a
 * security property, not a convenience: unanchored keyword matching used to
 * turn questions like "why did my gateway stop" into mutation proposals.
 *
 * Persistent operations require explicit approval, write audit records, and
 * lazy-load heavy CLI modules only when the selected operation needs them.
 */
type ConfigModule = typeof import("../config/config.js");
type ConfigFileSnapshot = Awaited<ReturnType<ConfigModule["readConfigFileSnapshot"]>>;
type SystemAgentOverviewLoader = () => Promise<SystemAgentOverview>;
type SystemAgentOverviewFormatter = (overview: SystemAgentOverview) => string;

const loadConfigModule = async () => await import("../config/config.js");
const loadOverviewModule = async () => await import("./overview.js");

/** Parsed OpenClaw operation before approval/execution. */
export type SystemAgentOperation =
  | { kind: "none"; message: string }
  | { kind: "overview" }
  | { kind: "doctor" }
  | { kind: "doctor-fix" }
  | { kind: "status" }
  | { kind: "health" }
  | { kind: "config-validate" }
  | { kind: "config-get"; path: string }
  | { kind: "config-schema"; path?: string }
  | { kind: "config-set"; path: string; value: string }
  | {
      kind: "config-set-ref";
      path: string;
      source: "env" | "file" | "exec";
      id: string;
      provider?: string;
    }
  | { kind: "setup"; workspace?: string; model?: string }
  | { kind: "model-setup"; workspace?: string }
  | { kind: "channel-list" }
  | { kind: "channel-info"; channel: string }
  | { kind: "channel-setup"; channel: string }
  | {
      kind: "open-setup";
      target: "guided" | "classic" | "channels";
      channel?: string;
    }
  | { kind: "gateway-status" }
  | { kind: "gateway-start" }
  | { kind: "gateway-stop" }
  | { kind: "gateway-restart" }
  | { kind: "agents" }
  | { kind: "models" }
  | { kind: "plugin-list" }
  | { kind: "plugin-search"; query: string }
  | { kind: "plugin-install"; spec: string }
  | { kind: "plugin-uninstall"; pluginId: string }
  | { kind: "audit" }
  | { kind: "create-agent"; agentId: string; workspace?: string; model?: string }
  | { kind: "open-tui"; agentId?: string; workspace?: string }
  | { kind: "set-default-model"; model: string };

/** Result returned by the operation executor. */
export type SystemAgentOperationResult = {
  applied: boolean;
  exitsInteractive?: boolean;
  message?: string;
  nextInput?: string;
  /** Agent TUI exited via /openclaw: re-enter the shell even without a request. */
  returnToShell?: boolean;
  followUp?: Extract<SystemAgentOperation, { kind: "model-setup" }>;
};

/** Injectable command dependencies used by tests and alternate runners. */
export type SystemAgentCommandDeps = {
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
  ensureAuthProfileStore?: typeof import("../agents/auth-profiles/store.js").ensureAuthProfileStore;
  resolveCliAuthBindingFingerprint?: typeof import("../agents/cli-auth-epoch.js").resolveCliAuthBindingFingerprint;
  resolveApiKeyForProvider?: typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
  formatOverview?: SystemAgentOverviewFormatter;
  loadOverview?: SystemAgentOverviewLoader;
  runAgentsAdd?: (
    opts: {
      name?: string;
      workspace?: string;
      model?: string;
      nonInteractive?: boolean;
      json?: boolean;
    },
    runtime: RuntimeEnv,
    params?: { hasFlags?: boolean },
  ) => Promise<void>;
  runConfigSet?: (opts: {
    path?: string;
    value?: string;
    cliOptions: ConfigSetOptions;
  }) => Promise<void>;
  runDoctor?: (runtime: RuntimeEnv, options: DoctorOptions) => Promise<void>;
  runGatewayRestart?: () => Promise<void | boolean>;
  runGatewayStart?: () => Promise<void>;
  runGatewayStop?: () => Promise<void>;
  runPluginInstall?: (spec: string, runtime: RuntimeEnv) => Promise<void>;
  runPluginUninstall?: (pluginId: string, runtime: RuntimeEnv) => Promise<void>;
  runPluginsList?: (runtime: RuntimeEnv) => Promise<void>;
  runPluginsSearch?: (query: string, runtime: RuntimeEnv) => Promise<void>;
  runTui?: (opts: {
    local: boolean;
    session?: string;
    deliver?: boolean;
    historyLimit?: number;
  }) => Promise<TuiResult | void>;
  /** Where setup side effects run; the gateway surface never manages its own daemon. */
  setupSurface?: "cli" | "gateway";
  applySetup?: typeof import("./setup-apply.js").applySystemAgentSetup;
  verifyInferenceConfig?: typeof import("./setup-inference.js").verifySetupInferenceConfig;
  listChannelSetupPlugins?: typeof import("../channels/plugins/setup-registry.js").listChannelSetupPlugins;
  resolveChannelSetupEntries?: typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;
  isChannelConfigured?: typeof import("../config/channel-configured-shared.js").isStaticallyChannelConfigured;
};

export function isPersistentSystemAgentOperation(operation: SystemAgentOperation): boolean {
  return (
    operation.kind === "set-default-model" ||
    operation.kind === "config-set" ||
    operation.kind === "config-set-ref" ||
    operation.kind === "setup" ||
    operation.kind === "plugin-install" ||
    (operation.kind === "create-agent" &&
      !operation.model?.trim() &&
      !isReservedSystemAgentId(operation.agentId)) ||
    operation.kind === "gateway-start" ||
    operation.kind === "gateway-stop" ||
    operation.kind === "gateway-restart"
  );
}

/** Format a user-facing description for an operation requiring approval. */
export function describeSystemAgentPersistentOperation(operation: SystemAgentOperation): string {
  switch (operation.kind) {
    case "set-default-model":
      return `set agents.defaults.model.primary to ${operation.model}`;
    case "config-set":
      return `set config ${operation.path} to ${formatConfigSetValueForPlan(operation.path, operation.value)}`;
    case "config-set-ref":
      return `set config ${operation.path} to ${operation.source} SecretRef ${operation.source === "env" ? operation.id : "<redacted>"}`;
    case "setup":
      return formatSetupPlanDescription(operation);
    case "model-setup":
      return "configure a model provider and default model";
    case "doctor-fix":
      return "exit OpenClaw and run openclaw doctor --fix";
    case "plugin-install":
      return `install plugin ${operation.spec}`;
    case "plugin-uninstall":
      return `uninstall plugin ${operation.pluginId}`;
    case "create-agent":
      return `create agent ${operation.agentId} with workspace ${formatCreateAgentWorkspace(operation.workspace)}`;
    case "gateway-start":
      return "start the Gateway";
    case "gateway-stop":
      return "stop the Gateway";
    case "gateway-restart":
      return "restart the Gateway";
    default:
      return "apply this action";
  }
}

/** Format the standard approval plan text for a persistent operation. */
export function formatSystemAgentPersistentPlan(operation: SystemAgentOperation): string {
  return `Plan: ${describeSystemAgentPersistentOperation(operation)}. Say yes to apply.`;
}

function formatCreateAgentWorkspace(workspace: string | undefined): string {
  return workspace ? shortenHomePath(resolveUserPath(workspace)) : shortenHomePath(process.cwd());
}

function formatConfigSetValueForPlan(configPath: string, value: string): string {
  if (isSensitiveConfigPath(configPath)) {
    return "<redacted>";
  }
  return value;
}

const CONFIG_GET_OUTPUT_MAX_CHARS = 2_000;
const CONFIG_SCHEMA_CHILDREN_MAX = 40;

function redactConfigValue(value: unknown, configPath: string): unknown {
  if (typeof value === "string" || typeof value === "number") {
    return isSensitiveConfigPath(configPath) ? "<redacted>" : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactConfigValue(entry, `${configPath}[]`));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactConfigValue(entry, configPath ? `${configPath}.${key}` : key),
      ]),
    );
  }
  return value;
}

function readConfigValueAtPath(config: unknown, path: string): { found: boolean; value?: unknown } {
  let current: unknown = config;
  for (const rawSegment of path.split(".")) {
    // Support foo[0] style array segments alongside dotted keys.
    const parts = rawSegment.split(/[[\]]/).filter(Boolean);
    for (const part of parts) {
      if (current === null || typeof current !== "object") {
        return { found: false };
      }
      const index = /^\d+$/.test(part) ? Number(part) : undefined;
      if (index !== undefined && Array.isArray(current)) {
        current = current[index];
      } else {
        current = (current as Record<string, unknown>)[part];
      }
      if (current === undefined) {
        return { found: false };
      }
    }
  }
  return { found: true, value: current };
}

function formatSetupPlanDescription(
  operation: Extract<SystemAgentOperation, { kind: "setup" }>,
): string {
  const workspace = shortenHomePath(resolveUserPath(operation.workspace ?? process.cwd()));
  return `bootstrap OpenClaw setup for workspace ${workspace}`;
}

function formatGatewayStatusLine(overview: SystemAgentOverview): string {
  return [
    `Gateway: ${overview.gateway.reachable ? "reachable" : "not reachable"}`,
    `URL: ${overview.gateway.url}`,
    `Source: ${overview.gateway.source}`,
    overview.gateway.error ? `Note: ${overview.gateway.error}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

async function runGatewayLifecycle(
  operation: "start" | "stop" | "restart",
): Promise<void | boolean> {
  const lifecycle = await import("../cli/daemon-cli/lifecycle.js");
  if (operation === "start") {
    await lifecycle.runDaemonStart();
    return;
  }
  if (operation === "stop") {
    await lifecycle.runDaemonStop();
    return;
  }
  return await lifecycle.runDaemonRestart();
}

async function readConfigFileSnapshotLazy(): Promise<ConfigFileSnapshot> {
  const { readConfigFileSnapshot } = await loadConfigModule();
  return await readConfigFileSnapshot();
}

async function loadOverviewForOperation(
  deps: SystemAgentCommandDeps | undefined,
): Promise<SystemAgentOverview> {
  if (deps?.loadOverview) {
    return await deps.loadOverview();
  }
  const { loadSystemAgentOverview } = await loadOverviewModule();
  return await loadSystemAgentOverview();
}

async function resolveChannelSetupState(deps: SystemAgentCommandDeps | undefined) {
  const listPlugins =
    deps?.listChannelSetupPlugins ??
    (await import("../channels/plugins/setup-registry.js")).listChannelSetupPlugins;
  const resolveEntries =
    deps?.resolveChannelSetupEntries ??
    (await import("../commands/channel-setup/discovery.js")).resolveChannelSetupEntries;
  const isConfigured =
    deps?.isChannelConfigured ??
    (await import("../config/channel-configured-shared.js")).isStaticallyChannelConfigured;
  const { shouldShowChannelInSetup } = await import("../commands/channel-setup/discovery.js");
  const snapshot = await readConfigFileSnapshotLazy();
  const cfg = snapshot.valid ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const installedPlugins = listPlugins();
  const resolved = resolveEntries({ cfg, installedPlugins });
  return {
    cfg,
    installedPlugins,
    resolved: {
      ...resolved,
      // Match the connect/list surfaces: setup-hidden channels stay invisible
      // to chat listings and channel info alike.
      entries: resolved.entries.filter((entry) => shouldShowChannelInSetup(entry.meta)),
    },
    isConfigured,
  };
}

function formatChannelDocsUrl(docsPath: string): string {
  return `https://docs.openclaw.ai${docsPath.startsWith("/") ? docsPath : `/${docsPath}`}`;
}

function formatConfigValidationLine(snapshot: ConfigFileSnapshot): string {
  if (!snapshot.exists) {
    return `Config missing: ${shortenHomePath(snapshot.path)}`;
  }
  if (snapshot.valid) {
    return `Config valid: ${shortenHomePath(snapshot.path)}`;
  }
  return [
    `Config invalid: ${shortenHomePath(snapshot.path)}`,
    ...snapshot.issues.map((issue) => {
      const issuePath = issue.path ? `${issue.path}: ` : "";
      return `  - ${issuePath}${issue.message}`;
    }),
  ].join("\n");
}

function createNoExitRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return {
    ...runtime,
    exit: (code) => {
      throw new Error(`operation exited with code ${code}`);
    },
  };
}

async function resolveTuiAgentId(params: {
  requestedAgentId: string | undefined;
  requestedWorkspace?: string;
  deps?: SystemAgentCommandDeps;
}): Promise<string | undefined> {
  const overview = await loadOverviewForOperation(params.deps);
  const workspace = params.requestedWorkspace
    ? resolveUserPath(params.requestedWorkspace)
    : undefined;
  if (workspace) {
    const workspaceMatch = overview.agents.find((agent) => {
      return agent.workspace ? resolveUserPath(agent.workspace) === workspace : false;
    });
    if (workspaceMatch) {
      return workspaceMatch.id;
    }
  }
  if (!params.requestedAgentId?.trim()) {
    return overview.defaultAgentId;
  }
  const requested = normalizeAgentId(params.requestedAgentId);
  const match = overview.agents.find((agent) => {
    return (
      normalizeAgentId(agent.id) === requested ||
      (agent.name ? normalizeAgentId(agent.name) === requested : false)
    );
  });
  return match?.id ?? requested;
}

type ExecuteOptions = {
  approved?: boolean;
  deps?: SystemAgentCommandDeps;
  auditDetails?: Record<string, unknown>;
  /**
   * Authority check used by the guarded commit seam for host-approved writes.
   * A multi-step operation may invoke it more than once; every invocation is
   * immediately followed by the persistent effect it authorizes.
   */
  beforePersistentApply?: () => Promise<void>;
};

/**
 * One persistent operation = one audited apply. The shared wrapper owns the
 * approval gate, before/after config hashes, the audit record, and the
 * `[openclaw] running/done` markers the e2e lanes assert on; each spec only
 * describes what to run and what to record.
 */
type PersistentApplyContext = {
  runtime: RuntimeEnv;
  deps?: SystemAgentCommandDeps;
  /** Re-check authority, then enter one persistent side-effect boundary. */
  commit<T>(effect: () => Promise<T> | T): Promise<T>;
};

type PersistentApplyOutcome = {
  summary: string;
  details?: Record<string, unknown>;
  /** Overrides the after-snapshot config path in the audit record. */
  configPath?: string;
};

async function applyPersistentOperation(params: {
  auditOperation: string;
  operation: SystemAgentOperation;
  runtime: RuntimeEnv;
  opts: ExecuteOptions;
  run: (ctx: PersistentApplyContext) => Promise<PersistentApplyOutcome>;
}): Promise<SystemAgentOperationResult> {
  const { auditOperation, runtime, opts } = params;
  if (!opts.approved) {
    const message = formatSystemAgentPersistentPlan(params.operation);
    runtime.log(message);
    return { applied: false, message };
  }
  runtime.log(`[openclaw] running: ${auditOperation}`);
  const { readConfigFileSnapshot } = await loadConfigModule();
  const before = await readConfigFileSnapshot();
  const commit: PersistentApplyContext["commit"] = async (effect) => {
    await opts.beforePersistentApply?.();
    return await effect();
  };
  const outcome = await params.run({ runtime, deps: opts.deps, commit });
  const after = await readConfigFileSnapshot();
  try {
    await appendSystemAgentAuditEntry({
      operation: auditOperation,
      summary: outcome.summary,
      configPath: outcome.configPath ?? after.path ?? before.path ?? undefined,
      configHashBefore: before.hash ?? null,
      configHashAfter: after.hash ?? null,
      details: { ...opts.auditDetails, ...outcome.details },
    });
  } catch (error) {
    // The mutation already committed. Keep success truthful while making the
    // missing audit record visible to every CLI/chat capture surface.
    runtime.error(
      `${outcome.summary}, but OpenClaw could not record its audit entry: ${formatErrorMessage(error)}`,
    );
  }
  runtime.log(`[openclaw] done: ${auditOperation}`);
  return { applied: true };
}

async function runConfigSetOperation(params: {
  operation: Extract<SystemAgentOperation, { kind: "config-set" | "config-set-ref" }>;
  ctx: PersistentApplyContext;
}): Promise<void> {
  const { operation, ctx } = params;
  const runConfigSet =
    ctx.deps?.runConfigSet ??
    (async (setOpts: { path?: string; value?: string; cliOptions: ConfigSetOptions }) => {
      const { runConfigSet: importedRunConfigSet } = await import("../cli/config-cli.js");
      await importedRunConfigSet({
        ...setOpts,
        runtime: createNoExitRuntime(ctx.runtime),
      });
    });
  if (operation.kind === "config-set") {
    await ctx.commit(async () => {
      await runConfigSet({ path: operation.path, value: operation.value, cliOptions: {} });
    });
    return;
  }
  await ctx.commit(async () => {
    await runConfigSet({
      path: operation.path,
      cliOptions: {
        refProvider: operation.provider ?? "default",
        refSource: operation.source,
        refId: operation.id,
      },
    });
  });
}

function isInferenceRouteConfigPath(path: readonly string[]): boolean {
  const segments = path.map((segment) => segment.trim().toLowerCase()).filter(Boolean);
  const [root, scope, ownerOrField, field] = segments;
  if (["$include", "auth", "env", "models", "plugins", "secrets", "tools"].includes(root ?? "")) {
    return true;
  }
  if (root !== "agents") {
    return false;
  }
  if (!scope || (scope === "defaults" && !ownerOrField) || (scope === "list" && !ownerOrField)) {
    return true;
  }
  if (scope === "defaults") {
    return ["agentruntime", "clibackends", "model", "models", "params", "tools"].includes(
      ownerOrField ?? "",
    );
  }
  if (scope !== "list") {
    return false;
  }
  if (/^\d+$/.test(ownerOrField ?? "") && !field) {
    return true;
  }
  const routeField = /^\d+$/.test(ownerOrField ?? "") ? field : ownerOrField;
  return [
    "agentdir",
    "agentruntime",
    "clibackends",
    "default",
    "id",
    "model",
    "models",
    "params",
    "tools",
  ].includes(routeField ?? "");
}

async function assertConfigWriteDoesNotBypassInferenceVerification(
  operation: Extract<SystemAgentOperation, { kind: "config-set" | "config-set-ref" }>,
): Promise<void> {
  const { parseConfigSetPath } = await import("../cli/config-cli.js");
  if (!isInferenceRouteConfigPath(parseConfigSetPath(operation.path))) {
    return;
  }
  throw new Error(
    "Direct config writes cannot change inference routing or include alternate config. Use `set default model <provider/model>` for an already configured route, or exit OpenClaw and run `openclaw onboard` to change provider/auth access.",
  );
}

async function verifyCurrentSetupInference(
  runtime: RuntimeEnv,
  deps?: SystemAgentCommandDeps,
): Promise<{
  modelRef: string;
  route: DefaultInferenceRouteProjection;
  latencyMs: number;
}> {
  const { readConfigFileSnapshot } = await loadConfigModule();
  const before = await readConfigFileSnapshot();
  if (!before.exists || !before.valid) {
    throw new Error(
      "OpenClaw setup requires a valid configured inference route. Exit OpenClaw and run `openclaw onboard`, then retry.",
    );
  }
  const beforeConfig = before.runtimeConfig ?? before.config;
  const beforeRoute = await projectDefaultInferenceRoute(beforeConfig);
  if (!beforeRoute.route) {
    throw new Error(
      "OpenClaw setup requires working inference first. Exit OpenClaw and run `openclaw onboard`, then retry.",
    );
  }
  const verifyInferenceConfig =
    deps?.verifyInferenceConfig ??
    (await import("./setup-inference.js")).verifySetupInferenceConfig;
  const verification = await verifyInferenceConfig({ config: beforeConfig, runtime });
  if (!verification.ok) {
    throw new Error(
      `OpenClaw setup requires working inference first. The configured route failed a live check: ${verification.error} Exit OpenClaw and run \`openclaw onboard\`, then retry.`,
    );
  }

  const after = await readConfigFileSnapshot();
  if (!after.exists || !after.valid) {
    throw new Error(
      "The default-agent inference route changed during setup verification, so setup was not applied. Review the current config and retry.",
    );
  }
  const afterConfig = after.runtimeConfig ?? after.config;
  const afterRoute = await projectDefaultInferenceRoute(afterConfig);
  if (
    !sameDefaultInferenceRoute(beforeRoute, afterRoute) ||
    verification.modelRef !== afterRoute.route?.modelLabel
  ) {
    throw new Error(
      "The default-agent inference route changed during setup verification, so setup was not applied. Review the current model/auth/runtime settings and retry.",
    );
  }
  return {
    modelRef: verification.modelRef,
    route: afterRoute,
    latencyMs: verification.latencyMs,
  };
}

async function executeSetup(
  operation: Extract<SystemAgentOperation, { kind: "setup" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  const overview = await loadOverviewForOperation(opts.deps);
  const defaultModel = overview.defaultModel?.trim();
  if (!defaultModel) {
    throw new Error(
      "OpenClaw setup requires working inference first. Run `openclaw onboard` to configure and verify a default model, then start OpenClaw again.",
    );
  }
  const requestedModel = operation.model?.trim();
  if (requestedModel && requestedModel !== defaultModel) {
    throw new Error(
      `OpenClaw setup will preserve the verified default model ${defaultModel}. Exit OpenClaw and run \`openclaw onboard\` to stage, live-test, and save a different inference route.`,
    );
  }
  if (!opts.approved) {
    const message = [
      formatSystemAgentPersistentPlan(operation),
      `Model choice: keep verified default ${defaultModel}.`,
    ].join("\n");
    runtime.log(message);
    return { applied: false, message };
  }
  const verified = await verifyCurrentSetupInference(runtime, opts.deps);
  if (requestedModel && requestedModel !== verified.modelRef) {
    throw new Error(
      `The verified default model is now ${verified.modelRef}, not ${requestedModel}. Review the current route or exit OpenClaw and run \`openclaw onboard\` before retrying setup.`,
    );
  }
  const workspace = resolveUserPath(operation.workspace ?? process.cwd());
  return await applyPersistentOperation({
    auditOperation: "openclaw.setup",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      const applySetup =
        ctx.deps?.applySetup ?? (await import("./setup-apply.js")).applySystemAgentSetup;
      const surface = ctx.deps?.setupSurface ?? "cli";
      // The outer boundary covers injected implementations. The production
      // setup helper also uses this same seam for each of its internal writes.
      const applied = await ctx.commit(
        async () =>
          await applySetup(
            {
              workspace,
              expectedInferenceRoute: verified.route,
              surface,
              runtime: ctx.runtime,
            },
            { commit: async (effect) => await ctx.commit(effect) },
          ),
      );
      const after = await readConfigFileSnapshotLazy();
      ctx.runtime.log(`Updated ${after.path || applied.configPath || "config"}`);
      for (const line of applied.lines) {
        ctx.runtime.log(line);
      }
      ctx.runtime.log(`Default model: ${verified.modelRef} (verified and kept)`);
      return {
        summary: "Bootstrapped setup workspace",
        configPath: after.path || applied.configPath,
        details: {
          workspace,
          model: verified.modelRef,
          modelSource: "live-verified default model",
          inferenceLatencyMs: verified.latencyMs,
        },
      };
    },
  });
}

async function executeSetDefaultModel(
  operation: Extract<SystemAgentOperation, { kind: "set-default-model" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  return await applyPersistentOperation({
    auditOperation: "config.setDefaultModel",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      const { mutateConfigFile, readConfigFileSnapshot } = await loadConfigModule();
      const { applySystemAgentModelSelection, createSystemAgentModelSelectionUpdater } =
        await import("./setup-apply.js");
      const snapshot = await readConfigFileSnapshot();
      const stagedConfig = await applySystemAgentModelSelection({
        config: snapshot.sourceConfig,
        model: operation.model,
      });
      const beforeRoute = await projectDefaultInferenceRoute(snapshot.sourceConfig);
      const verifiedRoute = await projectDefaultInferenceRoute(stagedConfig);
      const verifyInferenceConfig =
        ctx.deps?.verifyInferenceConfig ??
        (await import("./setup-inference.js")).verifySetupInferenceConfig;
      const initialVerification = await verifyInferenceConfig({
        config: stagedConfig,
        runtime: ctx.runtime,
        requireExecutionOwner: true,
      });
      if (!initialVerification.ok) {
        throw new Error(
          `The requested model failed a live inference test, so the current default model was not changed. ${initialVerification.error} Fix provider authentication or model access, then retry.`,
        );
      }
      const verifiedModelRef = verifiedRoute.route?.modelLabel;
      if (!verifiedModelRef || initialVerification.modelRef !== verifiedModelRef) {
        throw new Error(
          "The live inference test did not verify the exact model route that would be saved, so the current default model was not changed. Review model aliases and runtime routing, then retry.",
        );
      }
      let persistedVerification = initialVerification;
      let selectedRouteForCommit = verifiedRoute;
      const selectModel = await createSystemAgentModelSelectionUpdater({
        model: operation.model,
      });
      const result = await mutateConfigFile({
        base: "source",
        writeOptions: {
          preCommitRuntimePreflight: async (sourceConfig) => {
            const commitRoute = await projectDefaultInferenceRoute(sourceConfig);
            if (!sameDefaultInferenceRoute(commitRoute, selectedRouteForCommit)) {
              throw new Error(
                "The selected inference route changed while preparing the config write, so the requested model was not saved. Review the current model/auth/runtime settings and retry.",
              );
            }
            await opts.beforePersistentApply?.();
            const latestVerification = await verifyInferenceConfig({
              config: sourceConfig,
              runtime: ctx.runtime,
              requireExecutionOwner: true,
            });
            if (!latestVerification.ok) {
              throw new Error(
                `The requested model no longer passes live inference at the config commit boundary, so it was not saved. ${latestVerification.error} Review concurrent configuration changes and retry.`,
              );
            }
            if (latestVerification.modelRef !== commitRoute.route?.modelLabel) {
              throw new Error(
                "The final live inference test did not verify the exact model route at the config commit boundary, so the requested model was not saved. Review model aliases and runtime routing, then retry.",
              );
            }
            // The live probe can outlive the original OpenClaw authority.
            // Re-check it last, immediately before the writer crosses to disk.
            await opts.beforePersistentApply?.();
            persistedVerification = latestVerification;
          },
        },
        mutate: async (cfg) => {
          // Verification may take time. Preserve unrelated edits, but never
          // combine the passing result with a concurrently changed route.
          const currentRoute = await projectDefaultInferenceRoute(cfg);
          if (!sameDefaultInferenceRoute(currentRoute, beforeRoute)) {
            throw new Error(
              "The default-agent inference route changed during verification, so the requested model was not saved. Review the current model/auth/runtime settings and retry.",
            );
          }
          const selected = selectModel(cfg);
          const selectedRoute = await projectDefaultInferenceRoute(selected);
          if (selectedRoute.route?.modelLabel !== verifiedModelRef) {
            throw new Error(
              "The model selection no longer resolves to the exact model that passed live inference. Review the current model/auth/runtime settings and retry.",
            );
          }
          // Unrelated concurrent edits can change how the selected model is
          // represented. Bind the commit gate to this deterministic projection;
          // the final live probe below verifies these exact bytes before write.
          selectedRouteForCommit = selectedRoute;
          cfg.agents = selected.agents;
        },
      });
      ctx.runtime.log(`Updated ${result.path}`);
      ctx.runtime.log(`Default model: ${persistedVerification.modelRef}`);
      return {
        summary: `Set default model to ${operation.model}`,
        configPath: result.path,
        details: {
          requestedModel: operation.model,
          effectiveModel: persistedVerification.modelRef,
          inferenceVerified: true,
          inferenceLatencyMs: persistedVerification.latencyMs,
        },
      };
    },
  });
}

async function executePluginInstall(
  operation: Extract<SystemAgentOperation, { kind: "plugin-install" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  if (opts.approved) {
    const validationError = validateSystemAgentPluginInstallSpec(operation.spec);
    if (validationError) {
      throw new Error(validationError);
    }
  }
  const result = await applyPersistentOperation({
    auditOperation: "plugin.install",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      const runPluginInstall =
        ctx.deps?.runPluginInstall ??
        (async (spec: string, pluginRuntime: RuntimeEnv) => {
          const { runPluginInstallCommand } = await import("../cli/plugins-install-command.js");
          await runPluginInstallCommand({ raw: spec, opts: {}, runtime: pluginRuntime });
        });
      await ctx.commit(async () => {
        await runPluginInstall(operation.spec, createNoExitRuntime(ctx.runtime));
      });
      return { summary: `Installed plugin ${operation.spec}`, details: { spec: operation.spec } };
    },
  });
  if (result.applied) {
    runtime.log("Restart the Gateway to apply installed plugin changes.");
  }
  return result;
}

/** Execute a parsed OpenClaw operation after applying approval gates and audit logging. */
export async function executeSystemAgentOperation(
  operation: SystemAgentOperation,
  runtime: RuntimeEnv,
  opts: ExecuteOptions = {},
): Promise<SystemAgentOperationResult> {
  switch (operation.kind) {
    case "none":
      runtime.log(operation.message);
      return { applied: false, exitsInteractive: operation.message.includes("Bye.") };
    case "overview": {
      const overview = await loadOverviewForOperation(opts.deps);
      if (opts.deps?.formatOverview) {
        runtime.log(opts.deps.formatOverview(overview));
      } else {
        const { formatSystemAgentOverview } = await loadOverviewModule();
        runtime.log(formatSystemAgentOverview(overview));
      }
      return { applied: false };
    }
    case "agents": {
      const overview = await loadOverviewForOperation(opts.deps);
      runtime.log(
        [
          "Agents:",
          ...overview.agents.map((agent) => {
            const bits = [
              agent.id,
              agent.isDefault ? "default" : undefined,
              agent.name ? `name=${agent.name}` : undefined,
              agent.workspace
                ? `workspace=${shortenHomePath(resolveUserPath(agent.workspace))}`
                : undefined,
            ].filter(Boolean);
            return `  - ${bits.join(" | ")}`;
          }),
        ].join("\n"),
      );
      return { applied: false };
    }
    case "models": {
      const overview = await loadOverviewForOperation(opts.deps);
      runtime.log(
        [
          `Default model: ${overview.defaultModel ?? "not configured"}`,
          `Codex: ${overview.tools.codex.found ? "found" : "not found"}`,
          `Claude Code: ${overview.tools.claude.found ? "found" : "not found"}`,
          `Gemini CLI: ${overview.tools.gemini.found ? "found" : "not found"}`,
          `OpenAI key: ${overview.tools.apiKeys.openai ? "found" : "not found"}`,
          `Anthropic key: ${overview.tools.apiKeys.anthropic ? "found" : "not found"}`,
        ].join("\n"),
      );
      return { applied: false };
    }
    case "plugin-list": {
      const runPluginsList =
        opts.deps?.runPluginsList ??
        (async (pluginRuntime: RuntimeEnv) => {
          const { runPluginsListCommand } = await import("../cli/plugins-list-command.js");
          await runPluginsListCommand({}, pluginRuntime);
        });
      await runPluginsList(runtime);
      return { applied: false };
    }
    case "plugin-search": {
      const runPluginsSearch =
        opts.deps?.runPluginsSearch ??
        (async (query: string, pluginRuntime: RuntimeEnv) => {
          const { runPluginsSearchCommand } = await import("../cli/plugins-search-command.js");
          await runPluginsSearchCommand(query, {}, pluginRuntime);
        });
      await runPluginsSearch(operation.query, runtime);
      return { applied: false };
    }
    case "audit":
      runtime.log(`Audit log: ${resolveSystemAgentAuditPath()}`);
      runtime.log("Only applied writes/actions are recorded; discovery stays quiet.");
      return { applied: false };
    case "config-validate": {
      const snapshot = await readConfigFileSnapshotLazy();
      runtime.log(formatConfigValidationLine(snapshot));
      return { applied: false };
    }
    case "config-get": {
      const snapshot = await readConfigFileSnapshotLazy();
      if (!snapshot.exists) {
        runtime.log(`Config missing: ${shortenHomePath(snapshot.path)}`);
        return { applied: false };
      }
      const cfg = snapshot.valid
        ? (snapshot.sourceConfig ?? snapshot.config)
        : snapshot.sourceConfig;
      const lookup = readConfigValueAtPath(cfg ?? {}, operation.path);
      if (!lookup.found) {
        runtime.log(
          `${operation.path}: not set. Use \`config schema ${operation.path}\` to see what is allowed.`,
        );
        return { applied: false };
      }
      const redacted = redactConfigValue(lookup.value, operation.path);
      const rendered = JSON.stringify(redacted, null, 2) ?? "null";
      runtime.log(
        rendered.length > CONFIG_GET_OUTPUT_MAX_CHARS
          ? `${operation.path} = ${truncateUtf16Safe(rendered, CONFIG_GET_OUTPUT_MAX_CHARS)}\n… (truncated)`
          : `${operation.path} = ${rendered}`,
      );
      return { applied: false };
    }
    case "config-schema": {
      const { buildConfigSchema, lookupConfigSchema } = await import("../config/schema.js");
      const response = buildConfigSchema();
      const path = operation.path ?? ".";
      const result = lookupConfigSchema(response, path);
      if (!result) {
        runtime.log(`No config schema at "${path}". Try \`config schema .\` for the root keys.`);
        return { applied: false };
      }
      const schema = result.schema as {
        type?: string | string[];
        description?: string;
        enum?: unknown[];
        default?: unknown;
      };
      const childLines = result.children.slice(0, CONFIG_SCHEMA_CHILDREN_MAX).map((child) => {
        const type = Array.isArray(child.type) ? child.type.join("|") : (child.type ?? "object");
        const bits = [
          type,
          child.required ? "required" : undefined,
          child.hasChildren ? "…" : undefined,
        ]
          .filter(Boolean)
          .join(", ");
        return `  - ${child.path} (${bits})`;
      });
      runtime.log(
        [
          `Schema for ${result.path === "" ? "." : result.path}:`,
          schema.type
            ? `type: ${Array.isArray(schema.type) ? schema.type.join("|") : schema.type}`
            : undefined,
          schema.description ? `description: ${schema.description}` : undefined,
          schema.enum
            ? `allowed values: ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`
            : undefined,
          schema.default !== undefined ? `default: ${JSON.stringify(schema.default)}` : undefined,
          ...(childLines.length > 0 ? ["keys:", ...childLines] : []),
          result.children.length > CONFIG_SCHEMA_CHILDREN_MAX
            ? `… +${result.children.length - CONFIG_SCHEMA_CHILDREN_MAX} more keys`
            : undefined,
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
      );
      return { applied: false };
    }
    case "channel-list": {
      // Use the same discovery as channel setup (bundled plugins + trusted
      // catalog), so the listing matches what `connect <channel>` can configure
      // even before any plugin registry is active.
      const { resolved } = await resolveChannelSetupState(opts.deps);
      const entries = resolved.entries.toSorted((a, b) => a.id.localeCompare(b.id));
      runtime.log(
        [
          "Channels:",
          ...entries.map(
            (entry) => `  - ${entry.id}${entry.meta.label ? ` (${entry.meta.label})` : ""}`,
          ),
          "",
          "Say `connect <channel>` to walk through setup (for example `connect telegram`).",
        ].join("\n"),
      );
      return { applied: false };
    }
    case "channel-info": {
      const { cfg, installedPlugins, resolved, isConfigured } = await resolveChannelSetupState(
        opts.deps,
      );
      const channel = operation.channel.toLowerCase();
      const entry = resolved.entries.find((candidate) => candidate.id === channel);
      if (!entry) {
        const knownIds = resolved.entries.map((candidate) => candidate.id).toSorted();
        runtime.log(
          [
            `Unknown channel: ${channel}`,
            `Known channels: ${knownIds.length > 0 ? knownIds.join(", ") : "none"}`,
          ].join("\n"),
        );
        return { applied: false };
      }
      const installed =
        installedPlugins.some((plugin) => plugin.id === entry.id) ||
        resolved.installedCatalogById.has(entry.id);
      runtime.log(
        [
          `${entry.meta.label} (${entry.id})`,
          entry.meta.blurb,
          `Configured: ${isConfigured(cfg, entry.id) ? "yes" : "no"}`,
          `Installed: ${installed ? "yes" : "no"}`,
          `Docs: ${formatChannelDocsUrl(entry.meta.docsPath)}`,
          "",
          `Say \`connect ${entry.id}\` to set it up here, or \`open channel wizard for ${entry.id}\` for the masked terminal wizard.`,
        ].join("\n"),
      );
      return { applied: false };
    }
    case "channel-setup":
      // Channel setup is a multi-step wizard; only interactive OpenClaw (TUI
      // chat bridge or the gateway chat) can host it. One-shot mode points at
      // the guided paths.
      runtime.log(
        [
          `Connecting ${operation.channel} needs an interactive session.`,
          "Run `openclaw setup` and say `connect " + operation.channel + "`,",
          "or run `openclaw channels add` for the terminal wizard.",
        ].join("\n"),
      );
      return { applied: false };
    case "model-setup":
      runtime.log(
        [
          "Changing model providers must happen outside the inference session that powers OpenClaw.",
          "Exit OpenClaw and run `openclaw onboard`; it stages credentials, live-tests the candidate route, and saves only a passing setup.",
        ].join("\n"),
      );
      return { applied: false };
    case "open-setup": {
      const command =
        operation.target === "guided"
          ? "openclaw onboard"
          : operation.target === "classic"
            ? "openclaw onboard --classic"
            : `openclaw channels add${operation.channel ? ` --channel ${operation.channel}` : ""}`;
      runtime.log(
        `One-shot mode cannot open an interactive wizard. Run \`${command}\` in a terminal.`,
      );
      return { applied: false };
    }
    case "setup":
      return await executeSetup(operation, runtime, opts);
    case "config-set":
      await assertConfigWriteDoesNotBypassInferenceVerification(operation);
      return await applyPersistentOperation({
        auditOperation: "config.set",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          await runConfigSetOperation({ operation, ctx });
          return { summary: `Set config ${operation.path}`, details: { path: operation.path } };
        },
      });
    case "config-set-ref":
      await assertConfigWriteDoesNotBypassInferenceVerification(operation);
      return await applyPersistentOperation({
        auditOperation: "config.setRef",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          await runConfigSetOperation({ operation, ctx });
          return {
            summary: `Set config ${operation.path} SecretRef`,
            details: {
              path: operation.path,
              source: operation.source,
              provider: operation.provider ?? "default",
            },
          };
        },
      });
    case "plugin-install":
      return await executePluginInstall(operation, runtime, opts);
    case "plugin-uninstall": {
      const message = [
        "OpenClaw cannot prove that uninstalling a plugin will preserve its own active inference route.",
        `Exit OpenClaw and run \`openclaw plugins uninstall ${operation.pluginId}\` from a terminal.`,
      ].join("\n");
      runtime.log(message);
      return { applied: false, message };
    }
    case "create-agent": {
      if (isReservedSystemAgentId(operation.agentId)) {
        throw new Error(
          `Agent id "${normalizeAgentId(operation.agentId)}" is reserved for the system agent. Choose a different agent id.`,
        );
      }
      if (operation.model?.trim()) {
        throw new Error(
          "OpenClaw cannot save an explicit per-agent model until that new route can be live-tested. Retry without `model`; the new agent will inherit the already verified default model.",
        );
      }
      const workspace = resolveUserPath(operation.workspace ?? process.cwd());
      return await applyPersistentOperation({
        auditOperation: "agents.create",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runAgentsAdd =
            ctx.deps?.runAgentsAdd ??
            (await import("../commands/agents.commands.add.js")).agentsAddCommand;
          await ctx.commit(async () => {
            await runAgentsAdd(
              {
                name: operation.agentId,
                workspace,
                nonInteractive: true,
              },
              ctx.runtime,
              { hasFlags: true },
            );
          });
          return {
            summary: `Created agent ${operation.agentId}`,
            details: {
              agentId: operation.agentId,
              workspace,
            },
          };
        },
      });
    }
    case "doctor": {
      const runDoctor =
        opts.deps?.runDoctor ?? (await import("../commands/doctor.js")).doctorCommand;
      await runDoctor(runtime, { nonInteractive: true });
      return { applied: false };
    }
    case "doctor-fix":
      runtime.log(
        "Doctor repairs can change the inference route that powers this session. Exit OpenClaw and run `openclaw doctor --fix` in a terminal.",
      );
      return { applied: false };
    case "status": {
      const { statusCommand } = await import("../commands/status.command.js");
      await statusCommand({ timeoutMs: 10_000 }, runtime);
      return { applied: false };
    }
    case "health": {
      const { healthCommand } = await import("../commands/health.js");
      await healthCommand({ timeoutMs: 10_000 }, runtime);
      return { applied: false };
    }
    case "gateway-status": {
      const overview = await loadOverviewForOperation(opts.deps);
      runtime.log(formatGatewayStatusLine(overview));
      return { applied: false };
    }
    case "gateway-start":
      return await applyPersistentOperation({
        auditOperation: "gateway.start",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runGatewayStart = ctx.deps?.runGatewayStart ?? (() => runGatewayLifecycle("start"));
          await ctx.commit(runGatewayStart);
          return { summary: "Started Gateway" };
        },
      });
    case "gateway-stop":
      return await applyPersistentOperation({
        auditOperation: "gateway.stop",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runGatewayStop = ctx.deps?.runGatewayStop ?? (() => runGatewayLifecycle("stop"));
          await ctx.commit(runGatewayStop);
          return { summary: "Stopped Gateway" };
        },
      });
    case "gateway-restart":
      return await applyPersistentOperation({
        auditOperation: "gateway.restart",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runGatewayRestart =
            ctx.deps?.runGatewayRestart ?? (() => runGatewayLifecycle("restart"));
          const restarted = await ctx.commit(runGatewayRestart);
          if (restarted === false) {
            throw new Error("Gateway restart did not complete");
          }
          return { summary: "Restarted Gateway" };
        },
      });
    case "open-tui": {
      const agentId = await resolveTuiAgentId({
        requestedAgentId: operation.agentId,
        requestedWorkspace: operation.workspace,
        deps: opts.deps,
      });
      const session = agentId ? buildAgentMainSessionKey({ agentId }) : undefined;
      const runTui = opts.deps?.runTui ?? (await import("../tui/tui.js")).runTui;
      const result = await runTui({ local: true, session, deliver: false, historyLimit: 200 });
      if (result?.exitReason === "return-to-system-agent") {
        runtime.log(
          result.systemAgentMessage
            ? `[openclaw] returned from agent with request: ${result.systemAgentMessage}`
            : "[openclaw] returned from agent",
        );
        return { applied: false, returnToShell: true, nextInput: result.systemAgentMessage };
      }
      return { applied: false, exitsInteractive: true };
    }
    case "set-default-model":
      return await executeSetDefaultModel(operation, runtime, opts);
    default:
      return { applied: false };
  }
}
