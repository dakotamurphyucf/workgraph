import type { HttpResult } from "../../../core/protocol/http";
import type { BlobRef, PayloadChunk } from "./types";
/** One pinned source. Supplier must retain its exact capture/part and obey abort. */
export interface ChunkSupplier {
  readonly read: (offset: string, signal: AbortSignal) => Promise<HttpResult<PayloadChunk>>;
}
export interface VerifiedTransfer {
  /** One active full transfer, ≤64 MiB; rejects busy, never queues another file. Absolute deadline: 300 seconds. */
  readonly download: (
    source: BlobRef,
    supplier: ChunkSupplier,
    progress: (received: number, total: number) => void,
    signal?: AbortSignal,
  ) => Promise<TransferResult>;
  readonly dispose: () => void;
}
export type TransferResult =
  | { readonly ok: true; readonly blob: Blob; readonly digest: string }
  | {
      readonly ok: false;
      readonly kind: "busy" | "cancelled" | "timeout" | "input" | "protocol" | "read";
      readonly message: string;
    };
