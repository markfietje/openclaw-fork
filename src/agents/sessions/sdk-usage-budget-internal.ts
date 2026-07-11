/** Private token used by embedded runners that install model-call budget enforcement. */
export const AGENT_SESSION_MODEL_CALL_USAGE_BUDGET_ENFORCEMENT: unique symbol = Symbol(
  "openclaw.agent-session.model-call-usage-budget-enforcement",
);

export type AgentSessionUsageBudgetEnforcementToken =
  typeof AGENT_SESSION_MODEL_CALL_USAGE_BUDGET_ENFORCEMENT;

export type AgentSessionUsageBudgetEnforcementOptions = {
  usageBudgetEnforcement?: AgentSessionUsageBudgetEnforcementToken;
};

export function hasAgentSessionModelCallUsageBudgetEnforcement(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    (options as AgentSessionUsageBudgetEnforcementOptions).usageBudgetEnforcement ===
      AGENT_SESSION_MODEL_CALL_USAGE_BUDGET_ENFORCEMENT
  );
}
