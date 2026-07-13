import {
  enableSessionSuspensionTimersForGatewayStart,
  getCleanupSuspendedLaneIdsForGatewayPublication,
} from "../agents/session-suspension.js";
// Gateway command-lane concurrency applier.
// Pushes config-derived agent/cron limits into the process command queue.
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { resolveCronMaxConcurrentRuns } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

export type GatewayLaneConcurrency = {
  cron: number;
  main: number;
  subagent: number;
};

export function resolveGatewayLaneConcurrency(cfg: OpenClawConfig): GatewayLaneConcurrency {
  return {
    cron: resolveCronMaxConcurrentRuns(cfg.cron),
    main: resolveAgentMaxConcurrent(cfg),
    subagent: resolveSubagentMaxConcurrent(cfg),
  };
}

function enableGatewayStartSuspensionTimers(
  concurrency: GatewayLaneConcurrency,
): ReadonlySet<string> {
  const resumeConcurrencyByLane = new Map<string, number>([
    [CommandLane.Cron, concurrency.cron],
    [CommandLane.CronNested, concurrency.cron],
    [CommandLane.Main, concurrency.main],
    [CommandLane.Nested, 1],
    [CommandLane.Subagent, concurrency.subagent],
  ]);
  return enableSessionSuspensionTimersForGatewayStart(
    (laneId, savedResumeConcurrency) =>
      resumeConcurrencyByLane.get(laneId) ?? savedResumeConcurrency,
  );
}

export function applyGatewayLaneConcurrency(
  concurrency: GatewayLaneConcurrency,
  opts: { gatewayStart?: boolean } = {},
): void {
  const suspendedLaneIds: ReadonlySet<string> = opts.gatewayStart
    ? enableGatewayStartSuspensionTimers(concurrency)
    : getCleanupSuspendedLaneIdsForGatewayPublication();
  // Resolution is deliberately separate: this commit-edge applier only updates
  // live queue state and cannot reject a config midway through publication.
  if (!suspendedLaneIds.has(CommandLane.Cron)) {
    setCommandLaneConcurrency(CommandLane.Cron, concurrency.cron);
  }
  // Cron isolated agent turns remap inner LLM work to this lane.
  if (!suspendedLaneIds.has(CommandLane.CronNested)) {
    setCommandLaneConcurrency(CommandLane.CronNested, concurrency.cron);
  }
  if (!suspendedLaneIds.has(CommandLane.Main)) {
    setCommandLaneConcurrency(CommandLane.Main, concurrency.main);
  }
  if (opts.gatewayStart) {
    // sessions.send work uses a shared nested lane with no config knob; live
    // reload must not resume a currently suspended nested lane before its TTL.
    if (!suspendedLaneIds.has(CommandLane.Nested)) {
      setCommandLaneConcurrency(CommandLane.Nested, 1);
    }
  }
  if (!suspendedLaneIds.has(CommandLane.Subagent)) {
    setCommandLaneConcurrency(CommandLane.Subagent, concurrency.subagent);
  }
}
