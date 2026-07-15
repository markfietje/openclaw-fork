import {
  resolvePluginInstallRequestContext,
  type PluginInstallRequestContext,
} from "../cli/plugin-install-config-policy.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";

type PluginInstallPreflightResult =
  | { ok: true; action: "install"; request: PluginInstallRequestContext }
  | {
      ok: true;
      action: "reuse";
      request: PluginInstallRequestContext;
      installedVersion: string;
    }
  | {
      ok: false;
      code: "plugin_version_conflict";
      request: PluginInstallRequestContext;
      installedVersion: string;
      expectedVersion: string;
    }
  | { ok: false; code: "invalid_plugin_spec"; error: string };

export type InstalledClawHubPluginResolution =
  | { status: "missing" }
  | { status: "ambiguous"; pluginIds: string[] }
  | {
      status: "found";
      pluginId: string;
      record: PluginInstallRecord;
      installedVersion?: string;
    };

/** Resolves one installed plugin by its stable ClawHub package identity. */
export async function resolveInstalledClawHubPlugin(params: {
  clawhubPackage: string;
  loadInstallRecords?: typeof loadInstalledPluginIndexInstallRecords;
}): Promise<InstalledClawHubPluginResolution> {
  const records = await (params.loadInstallRecords ?? loadInstalledPluginIndexInstallRecords)();
  const matches = Object.entries(records).filter(
    ([, record]) =>
      (record.clawhubPackage ??
        parseClawHubPluginSpec(record.spec ?? "")?.name ??
        parseClawHubPluginSpec(record.resolvedSpec ?? "")?.name) === params.clawhubPackage,
  );
  if (matches.length === 0) {
    return { status: "missing" };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", pluginIds: matches.map(([pluginId]) => pluginId).toSorted() };
  }
  const [pluginId, record] = matches[0];
  return {
    status: "found",
    pluginId,
    record,
    installedVersion: record.resolvedVersion ?? record.version,
  };
}

export async function preflightPluginInstall(params: {
  clawhubPackage: string;
  rawSpec: string;
  expectedVersion: string;
  marketplace?: string;
  loadInstallRecords?: typeof loadInstalledPluginIndexInstallRecords;
}): Promise<PluginInstallPreflightResult> {
  const resolved = resolvePluginInstallRequestContext({
    rawSpec: params.rawSpec,
    ...(params.marketplace ? { marketplace: params.marketplace } : {}),
    installKind: "plugin",
  });
  if (!resolved.ok) {
    return { ok: false, code: "invalid_plugin_spec", error: resolved.error };
  }

  const records = await (params.loadInstallRecords ?? loadInstalledPluginIndexInstallRecords)();
  const installed = Object.values(records).find(
    (record) =>
      (record.clawhubPackage ?? parseClawHubPluginSpec(record.spec ?? "")?.name) ===
      params.clawhubPackage,
  );
  const installedVersion = installed?.resolvedVersion ?? installed?.version;
  if (!installedVersion) {
    return { ok: true, action: "install", request: resolved.request };
  }
  if (installedVersion === params.expectedVersion) {
    return { ok: true, action: "reuse", request: resolved.request, installedVersion };
  }
  return {
    ok: false,
    code: "plugin_version_conflict",
    request: resolved.request,
    installedVersion,
    expectedVersion: params.expectedVersion,
  };
}
