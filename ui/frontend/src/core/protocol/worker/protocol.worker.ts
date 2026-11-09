import { createWorkerSession } from "./session";
const session = createWorkerSession((message, transfer) => {
  globalThis.postMessage(message, { transfer });
});
globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  session.receive(event.data);
});
