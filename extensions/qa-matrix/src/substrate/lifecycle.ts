export type MatrixQaSubstrateRuntime = {
  baseUrl: string;
};

export type MatrixQaSubstrateState<Runtime extends MatrixQaSubstrateRuntime> =
  | { status: "stopped" }
  | { runtime: Runtime; status: "running" };

export type MatrixQaSubstrate<Runtime extends MatrixQaSubstrateRuntime> = {
  readonly id: string;
  readonly state: MatrixQaSubstrateState<Runtime>;
  restart(): Promise<Runtime>;
  start(): Promise<Runtime>;
  stop(): Promise<void>;
};

export type MatrixQaLifecycleScenarioId =
  | "cold-start"
  | "idempotent-start"
  | "restart"
  | "stop"
  | "resume";

export type MatrixQaLifecycleScenarioResult = {
  baseUrl: string;
  id: MatrixQaLifecycleScenarioId;
};

export function createMatrixQaSubstrate<Runtime extends MatrixQaSubstrateRuntime>(params: {
  id: string;
  start(): Promise<Runtime>;
  stop(runtime: Runtime): Promise<void>;
}): MatrixQaSubstrate<Runtime> {
  let state: MatrixQaSubstrateState<Runtime> = { status: "stopped" };

  const substrate: MatrixQaSubstrate<Runtime> = {
    id: params.id,
    get state() {
      return state;
    },
    async restart() {
      await substrate.stop();
      return await substrate.start();
    },
    async start() {
      if (state.status === "running") {
        return state.runtime;
      }
      const runtime = await params.start();
      state = { runtime, status: "running" };
      return runtime;
    },
    async stop() {
      if (state.status === "stopped") {
        return;
      }
      const runtime = state.runtime;
      await params.stop(runtime);
      state = { status: "stopped" };
    },
  };

  return substrate;
}

async function assertMatrixQaSubstrateUnreachable(baseUrl: string, fetchImpl: typeof fetch) {
  try {
    const response = await fetchImpl(new URL("_matrix/client/versions", baseUrl), {
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel();
  } catch {
    return;
  }
  throw new Error(`Matrix substrate remained reachable after stop: ${baseUrl}`);
}

export async function runMatrixQaLifecycleScenarios<
  Runtime extends MatrixQaSubstrateRuntime,
>(params: {
  fetchImpl?: typeof fetch;
  probe(runtime: Runtime): Promise<void>;
  substrate: MatrixQaSubstrate<Runtime>;
}): Promise<MatrixQaLifecycleScenarioResult[]> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const results: MatrixQaLifecycleScenarioResult[] = [];

  const coldStart = await params.substrate.start();
  await params.probe(coldStart);
  results.push({ baseUrl: coldStart.baseUrl, id: "cold-start" });

  const repeatedStart = await params.substrate.start();
  if (repeatedStart !== coldStart) {
    throw new Error("Matrix substrate start must be idempotent while running");
  }
  await params.probe(repeatedStart);
  results.push({ baseUrl: repeatedStart.baseUrl, id: "idempotent-start" });

  const restarted = await params.substrate.restart();
  if (restarted.baseUrl !== coldStart.baseUrl) {
    await assertMatrixQaSubstrateUnreachable(coldStart.baseUrl, fetchImpl);
  }
  await params.probe(restarted);
  results.push({ baseUrl: restarted.baseUrl, id: "restart" });

  await params.substrate.stop();
  if (params.substrate.state.status !== "stopped") {
    throw new Error("Matrix substrate did not enter stopped state");
  }
  await assertMatrixQaSubstrateUnreachable(restarted.baseUrl, fetchImpl);
  results.push({ baseUrl: restarted.baseUrl, id: "stop" });

  const resumed = await params.substrate.start();
  await params.probe(resumed);
  results.push({ baseUrl: resumed.baseUrl, id: "resume" });

  return results;
}
