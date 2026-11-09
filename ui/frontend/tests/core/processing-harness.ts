/** Explicit test-only loopback. Production always constructs a dedicated browser Worker. */
import { createProtocolProcessor } from "../../src/core/protocol/worker";
import { createWorkerSession } from "../../src/core/protocol/worker/session";
import type { ProtocolWorkerFactory, ProtocolWorkerPort } from "../../src/core/protocol/worker";
export const inProcessWorker: ProtocolWorkerFactory = (): ProtocolWorkerPort => {
  let disposed = false;
  let receive: ((value: unknown) => void) | null = null;
  let failed: ((error: Error) => void) | null = null;
  const session = createWorkerSession((message, transfer) => {
    const copy: unknown = structuredClone(message, { transfer });
    queueMicrotask(() => {
      if (!disposed) receive?.(copy);
    });
  });
  return {
    listen(onMessage, onError) {
      receive = onMessage;
      failed = onError;
      return () => {
        receive = null;
        failed = null;
      };
    },
    send(message, transfer = []) {
      const copy: unknown = structuredClone(message, { transfer });
      queueMicrotask(() => {
        if (!disposed) {
          try {
            session.receive(copy);
          } catch (error: unknown) {
            failed?.(
              error instanceof Error ? error : new Error("Unexpected test worker exception"),
            );
          }
        }
      });
    },
    terminate() {
      disposed = true;
      session.dispose();
    },
  };
};
export function createTestProcessor() {
  return createProtocolProcessor(inProcessWorker);
}
