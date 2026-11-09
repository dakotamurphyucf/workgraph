export type UploadHashReply =
  | { readonly kind: "digest"; readonly digest: string }
  | { readonly kind: "failed"; readonly name: string; readonly message: string };
/** Worker-side outcome. Failure is an explicit small message, never a floating
 * rejected Promise whose reporting differs between browser worker runtimes. */
export async function digestUploadBlob(
  blob: Blob,
  ports: {
    readonly read?: (blob: Blob) => Promise<ArrayBuffer>;
    readonly digest?: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
  } = {},
): Promise<UploadHashReply> {
  try {
    const bytes = await (ports.read ? ports.read(blob) : blob.arrayBuffer());
    const hash = await (ports.digest
      ? ports.digest(bytes)
      : crypto.subtle.digest("SHA-256", bytes));
    return {
      kind: "digest",
      digest: Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, "0")).join(""),
    };
  } catch (error) {
    return {
      kind: "failed",
      name: (error instanceof Error ? error.name : "UnexpectedWorkerFailure").slice(0, 128),
      message: (error instanceof Error
        ? error.message
        : "Source worker threw an unexpected value."
      ).slice(0, 4096),
    };
  }
}
