// Session store writes are serialized per store path to avoid lost updates.
import { runQueuedStoreWrite } from "../../shared/store-writer-queue.js";
import { WRITER_QUEUES } from "./store-writer-state.js";

export type RunExclusiveSessionStoreWriteOptions = {
  reentrant?: boolean;
};

/** Runs a callback under the same per-store writer queue used in production. */
export async function withSessionStoreWriterForTest<T>(
  storePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await runExclusiveSessionStoreWrite(storePath, fn);
}

export async function runExclusiveSessionStoreWrite<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: RunExclusiveSessionStoreWriteOptions = {},
): Promise<T> {
  return await runQueuedStoreWrite({
    queues: WRITER_QUEUES,
    storePath,
    label: "runExclusiveSessionStoreWrite",
    fn,
    reentrant: opts.reentrant,
  });
}
