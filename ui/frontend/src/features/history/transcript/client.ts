import { jsonField, type JsonValue } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import type { Codec } from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { ReadLane } from "../../../core/protocol/types";
import * as codecs from "./codecs";
import type { Captured, CaptureChoice, HistoryScope, HistoryCapture } from "./types";
export function invalid(message: string): HttpResult<never> {
  return { ok: false, failure: { kind: "protocol", message, issue: undefined } };
}
export function sameCapture(left: HistoryCapture, right: HistoryCapture): boolean {
  return (
    left.workspace_id === right.workspace_id &&
    left.head === right.head &&
    left.sequence === right.sequence &&
    left.sessions.length === right.sessions.length &&
    left.sessions.every(
      (item, index) =>
        item.session_id === right.sessions[index]?.session_id &&
        item.through === right.sessions[index]?.through,
    )
  );
}
export function historyParams(
  scope: HistoryScope,
  capture: CaptureChoice,
  fields: readonly (readonly [string, JsonValue])[],
) {
  return d.jsonObject([
    ["workspace_id", d.jsonString(scope.workspaceId)],
    ["max_bytes", d.jsonString("1048576")],
    ...(capture.kind === "current"
      ? []
      : [["head", capture.head === null ? d.jsonNull() : d.jsonString(capture.head)] as const]),
    ...fields,
  ]);
}
export function createHistoryClient(http: HttpClient) {
  const companion = createCompanion(http);
  return {
    read: async <T>(
      scope: HistoryScope,
      method: string,
      capture: CaptureChoice,
      fields: readonly (readonly [string, JsonValue])[],
      codec: Codec<T>,
      signal: AbortSignal,
      lane: ReadLane = "history",
    ): Promise<HttpResult<Captured<T>>> => {
      const result = await companion.read(
        {
          connection_id: scope.connectionId,
          generation: scope.generation,
          method,
          params: historyParams(scope, capture, fields),
          lane,
        },
        signal,
      );
      if (!result.ok) return result;
      const decoded = codec.decode(result.data.response.data),
        meta = codecs.historyCapture.decode(
          jsonField(result.data.response.meta, "history_capture"),
        );
      if (!decoded.ok)
        return invalid(
          `Invalid ${method} data at ${decoded.issue.path.join("/")}: expected ${decoded.issue.expected}.`,
        );
      if (!meta.ok) return invalid(`Invalid ${method} history capture: ${meta.issue.expected}.`);
      if (
        meta.value.workspace_id !== scope.workspaceId ||
        (capture.kind === "pinned" && meta.value.head !== capture.head)
      )
        return invalid("History result changed the requested workspace or immutable capture.");
      return {
        ok: true,
        data: { data: decoded.value, capture: meta.value },
        httpStatus: result.httpStatus,
      };
    },
  };
}
