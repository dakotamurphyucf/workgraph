import { WIRE_LIMITS, type GraphPart } from "./wire";
export type WorkerMessage =
  | { readonly kind: "start" | "ready"; readonly id: string }
  | {
      readonly kind: "input" | "output";
      readonly id: string;
      readonly sequence: number;
      readonly part: GraphPart;
    }
  | { readonly kind: "accepted" | "ack"; readonly id: string; readonly sequence: number }
  | { readonly kind: "failure"; readonly id: string; readonly message: string }
  | {
      readonly kind: "error";
      readonly id: string;
      readonly error: { readonly name: string; readonly message: string; readonly stack: string };
    };
export function dataObject<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const names = Object.keys(value);
  return names.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
const sequence = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= WIRE_LIMITS.graphRecords;
function part(value: unknown): value is GraphPart {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "end") return dataObject(value, ["kind", "root"]) && sequence(value.root);
  if (value.kind === "records")
    return (
      dataObject(value, ["kind", "bytes"]) &&
      value.bytes instanceof ArrayBuffer &&
      value.bytes.byteLength <= WIRE_LIMITS.packetBytes
    );
  return (
    value.kind === "buffer" &&
    dataObject(value, ["kind", "index", "bytes"]) &&
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    value.index <= WIRE_LIMITS.graphNodes &&
    value.bytes instanceof ArrayBuffer &&
    value.bytes.byteLength <= WIRE_LIMITS.bufferBytes
  );
}
export function readMessage(value: unknown): WorkerMessage | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^job-[1-9][0-9]{0,63}$/u.test(value.id)
  )
    return null;
  switch (value.kind) {
    case "start":
    case "ready":
      return dataObject(value, ["kind", "id"]) ? (value as WorkerMessage) : null;
    case "accepted":
    case "ack":
      return dataObject(value, ["kind", "id", "sequence"]) && sequence(value.sequence)
        ? (value as WorkerMessage)
        : null;
    case "input":
    case "output":
      return dataObject(value, ["kind", "id", "sequence", "part"]) &&
        sequence(value.sequence) &&
        part(value.part)
        ? (value as WorkerMessage)
        : null;
    case "failure":
      return dataObject(value, ["kind", "id", "message"]) &&
        typeof value.message === "string" &&
        value.message.length <= 4096
        ? (value as WorkerMessage)
        : null;
    case "error":
      return dataObject(value, ["kind", "id", "error"]) &&
        dataObject(value.error, ["name", "message", "stack"]) &&
        [value.error.name, value.error.message, value.error.stack].every(
          (text) => typeof text === "string" && text.length <= 4096,
        )
        ? (value as WorkerMessage)
        : null;
    default:
      return null;
  }
}
export function transfers(message: WorkerMessage): Transferable[] {
  return (message.kind === "input" || message.kind === "output") && message.part.kind !== "end"
    ? [message.part.bytes]
    : [];
}
