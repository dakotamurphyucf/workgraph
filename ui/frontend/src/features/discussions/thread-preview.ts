import type { JsonValue } from "../../core/json";
import * as d from "../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../core/protocol/http";
import { invocation, read } from "./threads/client";
import type { Endpoint, ReadCapture, Thread } from "./threads/types";

/** The native API requires both the communication revision and discussion serial
 * for nonzero message offsets. Capture that serial with one message first, then
 * fetch only the final message; never guess it from a thread's metadata revision. */
export async function readThreadPreview(
  http: HttpClient,
  endpoint: Endpoint,
  thread: Thread,
  revision: string,
  signal: AbortSignal,
): Promise<HttpResult<ReadCapture>> {
  const selector = { kind: "thread" as const, threadId: thread.id };
  const request = invocation(endpoint, selector);
  const fields: [string, JsonValue][] = request.params.fields
    .filter((field) => field.name !== "message_offset" && field.name !== "message_limit")
    .map((field) => [field.name, field.value]);
  fields.push(["message_limit", d.jsonString("1")], ["revision", d.jsonString(revision)]);
  const first = await read(
    http,
    endpoint,
    selector,
    {
      ...request,
      params: d.jsonObject([...fields, ["message_offset", d.jsonString("0")]]),
    },
    signal,
  );
  if (!first.ok || signal.aborted) return first;
  const value = first.data.captured.value;
  if (
    value.kind !== "thread" ||
    value.thread.related === undefined ||
    value.thread.commentIds.length <= 1
  )
    return first;
  return read(
    http,
    endpoint,
    selector,
    {
      ...request,
      params: d.jsonObject([
        ...fields,
        ["message_offset", d.jsonString(String(value.thread.commentIds.length - 1))],
        ["discussion_serial", d.jsonString(value.thread.related.discussionSerial)],
      ]),
    },
    signal,
  );
}
