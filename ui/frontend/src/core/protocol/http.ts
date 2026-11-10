import { createProtocolProcessor, type ProtocolProcessor } from "./worker";
import { DEFAULT_JSON_LIMITS, type JsonValue } from "../json";
import type { Codec, DecodeIssue } from "./codec";
import { envelope } from "./decoders";
import { HTTP_LIMITS } from "./worker/jobs";
import type { Problem } from "./types";

export type HttpFailure =
  | { readonly kind: "input"; readonly message: string }
  | { readonly kind: "aborted" }
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "protocol"; readonly message: string; readonly issue: DecodeIssue | undefined }
  | { readonly kind: "remote"; readonly problem: Problem; readonly httpStatus: number };
export type HttpResult<T> =
  | { readonly ok: true; readonly data: T; readonly httpStatus: number }
  | { readonly ok: false; readonly failure: HttpFailure };
export interface HttpRequest<T> {
  /** Relative API path. Never a URL or a daemon socket path. */
  readonly path: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly body?: JsonValue;
  readonly codec: Codec<T>;
  /** Full operation inspections contain duplicated captured request/receipt data. */
  readonly responseBudget?: "ordinary" | "operation";
  readonly signal?: AbortSignal;
}
export interface HttpClient {
  readonly processing: ProtocolProcessor;
  readonly request: <T>(request: HttpRequest<T>) => Promise<HttpResult<T>>;
}
export interface HttpOptions {
  readonly processing?: ProtocolProcessor;
  readonly origin: string;
  readonly capability: string;
  /**
   * Defaults to browser fetch. The native companion always sends a fixed,
   * unencoded Content-Length. Test transports must model that framing, including
   * cancellation/truncation; this client is not a general HTTP body adapter.
   */
  readonly fetch?: typeof fetch;
}

const prefix = "/ui-api/v1";
function protocol(message: string, issue?: DecodeIssue): HttpResult<never> {
  return { ok: false, failure: { kind: "protocol", message, issue } };
}

async function boundedBody(
  response: Response,
  maximumBytes: number,
): Promise<HttpResult<Uint8Array>> {
  const length = response.headers.get("content-length");
  if (
    response.headers.has("transfer-encoding") ||
    response.headers.has("content-encoding") ||
    length === null ||
    !/^(0|[1-9][0-9]{0,7})$/u.test(length)
  ) {
    await response.body?.cancel();
    return protocol("Companion response requires a fixed, unencoded Content-Length.");
  }
  const declared = Number(length);
  if (declared > maximumBytes) {
    await response.body?.cancel();
    return protocol("Response exceeds the JSON byte budget.");
  }
  if (response.body === null) return protocol("JSON response body is missing.");
  // Browser HTTP framing limits this original, unencoded body to its admitted
  // Content-Length. A manual stream consumer causes spurious ERR_ABORTED events
  // in the qualified Chrome build, including after fully consumed responses.
  // Keep the original native body consumer; do not pipe or clone the response.
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== declared)
    return protocol("Companion response length differs from its Content-Length.");
  return { ok: true, data: bytes, httpStatus: response.status };
}

/**
 * Same-origin, capability-bound HTTP only. Only explicitly read-only routes retry a transport failure, at most once,
 * immediately. Browser Fetch exposes network failures as TypeError, not a TCP
 * reset code. Domain/protocol failures and aborted requests never retry. Writes
 * remain single-send: transport failure cannot establish their durable outcome.
 */
export function createHttpClient(options: HttpOptions): HttpClient {
  const base = new URL(options.origin);
  if (base.origin !== options.origin || !["http:", "https:"].includes(base.protocol)) {
    throw new Error("HTTP client requires an exact HTTP(S) origin.");
  }
  if (!/^[a-f0-9]{64}(?![\s\S])/u.test(options.capability)) {
    throw new Error("HTTP client requires the launch capability from its bootstrap.");
  }
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const processing = options.processing ?? createProtocolProcessor();
  return {
    processing,
    request: async <T>(input: HttpRequest<T>): Promise<HttpResult<T>> => {
      const request = { ...input };
      if (request.signal?.aborted) return { ok: false, failure: { kind: "aborted" } };
      if (
        !request.path.startsWith("/") ||
        request.path.startsWith("//") ||
        request.path.includes("#")
      ) {
        return { ok: false, failure: { kind: "input", message: "Expected a relative API route." } };
      }
      const url = new URL(prefix + request.path, base);
      if (url.origin !== base.origin || !url.pathname.startsWith(prefix + "/")) {
        return {
          ok: false,
          failure: { kind: "input", message: "Route leaves the companion API." },
        };
      }
      let body: string | undefined;
      if (request.body !== undefined) {
        const processed = await processing.encode(request.body, {
          limits: HTTP_LIMITS,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (!processed.ok)
          return processed.failure.kind === "aborted"
            ? { ok: false, failure: { kind: "aborted" } }
            : protocol(processed.failure.message);
        const encoded = processed.value;
        if (!encoded.ok)
          return { ok: false, failure: { kind: "input", message: encoded.error.message } };
        body = encoded.value;
      }
      if ((request.method === "GET") !== (body === undefined)) {
        return {
          ok: false,
          failure: {
            kind: "input",
            message: "GET has no body; writes and read invocations require a JSON body.",
          },
        };
      }
      const headers: Record<string, string> = {
        Accept: "application/json",
        "X-Workgraph-UI-Capability": options.capability,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const init: RequestInit = {
        method: request.method,
        headers,
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        ...(body === undefined ? {} : { body }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };
      const maximumBytes =
        request.responseBudget === "operation" ? 16 * 1024 * 1024 : DEFAULT_JSON_LIMITS.maxBytes;
      const safeRead =
        request.method === "GET" ||
        (request.method === "POST" &&
          [
            "/read",
            "/live-observations",
            "/live-observations/cancel",
            "/view-settings/inspect",
            "/view-settings/list",
            "/journals/list",
            "/journals/inspect",
          ].includes(request.path));
      const timeoutMs =
        request.path === "/connections" || request.path === "/live-observations/cancel"
          ? 10000
          : 45000;
      let response!: Response;
      let bodyResult!: HttpResult<Uint8Array>;
      for (let attempt = 0; ; attempt++) {
        const deadline = new AbortController();
        const timer = safeRead ? setTimeout(() => deadline.abort(), timeoutMs) : undefined;
        const signal =
          request.signal === undefined
            ? deadline.signal
            : AbortSignal.any([request.signal, deadline.signal]);
        try {
          response = await send(url, { ...init, signal });
          const contentType = response.headers
            .get("content-type")
            ?.split(";")[0]
            ?.trim()
            .toLowerCase();
          if (contentType !== "application/json") {
            await response.body?.cancel();
            return protocol("Companion did not return JSON.");
          }
          bodyResult = await boundedBody(response, maximumBytes);
          break;
        } catch (error: unknown) {
          if (request.signal?.aborted) return { ok: false, failure: { kind: "aborted" } };
          if (deadline.signal.aborted)
            return {
              ok: false,
              failure: { kind: "network", message: "Companion read timed out." },
            };
          if (error instanceof TypeError) {
            if (safeRead && attempt === 0) continue;
            return {
              ok: false,
              failure: {
                kind: "network",
                message: safeRead
                  ? "Companion connection failed after one read retry."
                  : "Companion connection failed; no request was retried.",
              },
            };
          }
          throw error;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      if (!bodyResult.ok) return bodyResult;
      const processed = await processing.decodeHttp(bodyResult.data, {
        budget: request.responseBudget ?? "ordinary",
        operation: request.codec.worker?.kind === "operation",
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (!processed.ok)
        return processed.failure.kind === "aborted"
          ? { ok: false, failure: { kind: "aborted" } }
          : protocol(processed.failure.message);
      if (!processed.value.ok) return protocol(processed.value.message, processed.value.issue);
      // Semantic operation validation already ran in worker; only the bounded closed DTO projection remains here.
      const decoded = envelope(request.codec.worker?.validated ?? request.codec).decode(
        processed.value.value,
      );
      if (!decoded.ok) return protocol("Invalid companion response.", decoded.issue);
      if (!decoded.value.ok)
        return {
          ok: false,
          failure: { kind: "remote", problem: decoded.value.error, httpStatus: response.status },
        };
      if (response.status !== 200 && response.status !== 202)
        return protocol("Success envelope has an unexpected HTTP status.");
      if (request.signal?.aborted) return { ok: false, failure: { kind: "aborted" } };
      return { ok: true, data: decoded.value.data, httpStatus: response.status };
    },
  };
}
