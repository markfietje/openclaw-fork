type VisibleDeliveryResult = { visibleReplySent: boolean };
type PendingCompletion = {
  resolve: (result: VisibleDeliveryResult) => void;
  reject: (error: unknown) => void;
};

export function createFeishuStreamingDeliveryCompletionQueue(
  attachDeliveryCompletion: <T extends object>(result: T, completion: Promise<unknown>) => T,
  finalize: (options?: { markClosedForReply?: boolean }) => Promise<void>,
  onIdle: () => void,
  isVisible: () => boolean,
) {
  const pending: PendingCompletion[] = [];
  let idleSideEffects: Promise<void> = Promise.resolve();
  return {
    waitForIdle: async () => await idleSideEffects,
    defer: () => {
      let resolveCompletion!: PendingCompletion["resolve"];
      let rejectCompletion!: PendingCompletion["reject"];
      const completion = new Promise<VisibleDeliveryResult>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      void completion.catch(() => undefined);
      pending.push({ resolve: resolveCompletion, reject: rejectCompletion });
      return attachDeliveryCompletion({ visibleReplySent: false }, completion);
    },
    queueIdle: (options?: { markClosedForReply?: boolean }) => {
      const completions = pending.splice(0);
      const next = idleSideEffects.then(async () => {
        try {
          await finalize(options);
          for (const completion of completions) {
            completion.resolve({ visibleReplySent: isVisible() });
          }
        } catch (error: unknown) {
          for (const completion of completions) {
            completion.reject(error);
          }
          throw error;
        } finally {
          onIdle();
        }
      });
      idleSideEffects = next.catch(() => undefined);
      return next;
    },
  };
}
