// Qa Lab plugin module implements Matrix live transport CLI behavior.
import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";
import { MATRIX_QA_RELEASE_SCENARIO_IDS } from "./profiles.js";

type MatrixQaCliRuntime = typeof import("./cli.runtime.js");
type MatrixQaAdapterRuntime = typeof import("./adapter.runtime.js");

const loadMatrixQaCliRuntime = createLazyCliRuntimeLoader<MatrixQaCliRuntime>(
  () => import("./cli.runtime.js"),
);
const loadMatrixQaAdapterRuntime = createLazyCliRuntimeLoader<MatrixQaAdapterRuntime>(
  () => import("./adapter.runtime.js"),
);

async function runQaMatrix(opts: LiveTransportQaCommandOptions) {
  await (await loadMatrixQaCliRuntime()).runQaMatrixCommand(opts);
}

export const matrixQaAdapterFactory: NonNullable<LiveTransportQaCliRegistration["adapterFactory"]> =
  {
    id: "matrix",
    scenarioIds: MATRIX_QA_RELEASE_SCENARIO_IDS,
    matches: ({ channelId, driver }) => driver === "live" && channelId === "matrix",
    async create(context) {
      return await (await loadMatrixQaAdapterRuntime()).createMatrixQaTransportAdapter(context);
    },
  };

export const matrixQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "matrix",
    adapterFactory: matrixQaAdapterFactory,
    description: "Run the Docker-backed Matrix live QA lane against a disposable homeserver",
    outputDirHelp: "Matrix QA artifact directory",
    profileHelp: "QA Lab Matrix profile: all, fast, release, or transport (default: all)",
    scenarioHelp: "Run only the named Matrix QA scenario (repeatable)",
    sutAccountHelp: "Temporary Matrix account id inside the QA gateway config",
    run: runQaMatrix,
  });
