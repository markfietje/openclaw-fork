/** Custom transcript entry type used to account for hidden compaction model calls. */
export const COMPACTION_USAGE_ACCOUNTING_CUSTOM_TYPE = "openclaw:compaction-usage";

/** Custom transcript entry type used to account for hidden/ephemeral model calls. */
export const MODEL_CALL_USAGE_ACCOUNTING_CUSTOM_TYPE = "openclaw:model-call-usage";

/** Metadata key that ties hidden model-call rows to their aggregate owner row. */
export const USAGE_BUDGET_OPERATION_ID_KEY = "usageBudgetOperationId";
