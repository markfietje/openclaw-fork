// Qa Matrix API module exposes the plugin public contract.
export {
  createMatrixQaSubstrate,
  runMatrixQaLifecycleScenarios,
  type MatrixQaLifecycleScenarioId,
  type MatrixQaLifecycleScenarioResult,
  type MatrixQaSubstrate,
  type MatrixQaSubstrateRuntime,
  type MatrixQaSubstrateState,
} from "./src/substrate/lifecycle.js";
export {
  createMatrixQaTuwunelSubstrate,
  type MatrixQaTuwunelRuntime,
} from "./src/substrate/tuwunel-lifecycle.runtime.js";
