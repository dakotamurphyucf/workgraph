import * as d from "../../core/protocol/decoders";
import { createHistoryClient, sameCapture } from "../history/transcript/client";
import { directoryPage } from "../history/transcript/codecs";
import type { HistoryCapture, Captured, DirectoryPage } from "../history/transcript/types";
import { jsonBoolean } from "../../core/protocol/decoders";
import {
  createCoordinationClient,
  invocation as coordinationInvocation,
} from "../participants/coordination/client";
import { poolCodec, reservationCodec } from "../participants/coordination/codecs";
import {
  createParticipantsClient,
  invocation as participantInvocation,
} from "../participants/runs/client";
import { jsonString } from "../../core/protocol/decoders";
import { jsonField } from "../../core/json";
import { createCompanion } from "../../core/protocol/client";
import type { HttpClient, HttpResult } from "../../core/protocol/http";
import { readTicketCollection } from "../work/collection";
import { DEFAULT_WORK_FILTERS, queryParams } from "../work/read-model";
import { decodeCapture, listCodec } from "../work/read-model.codec";
import type { WorkScope } from "../work/read-model.types";
import { continued, invocation, protocol, read } from "./threads/client";
import { complete } from "./threads/model";
import type { ThreadsRead } from "./threads/types";

export type ReferenceKind =
  | "session"
  | "ticket"
  | "board"
  | "thread"
  | "run"
  | "attempt"
  | "pool"
  | "reservation"
  | "project"
  | "milestone"
  | "resource";
export interface ReferenceChoice {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}
/** Read-only, workspace-wide suggestions. Never rewrite IDs or infer permission
 * from directory membership. Native continuations retain their original capture. */
export async function readReferenceChoices(
  http: HttpClient,
  scope: WorkScope,
  kind: ReferenceKind,
  signal: AbortSignal,
): Promise<HttpResult<readonly ReferenceChoice[]>> {
  const workspace = { ...scope, projectId: null };
  if (kind === "project" || kind === "milestone" || kind === "resource") {
    const client = createCompanion(http),
      rows = new Map<string, ReferenceChoice>();
    let offset = "0",
      revision: string | null = null;
    while (!signal.aborted) {
      const result = await client.read(
        {
          connection_id: scope.connection.id,
          generation: scope.connection.generation,
          method: `${kind}.list`,
          lane: "visible",
          params: d.jsonObject([
            ["workspace_id", d.jsonString(scope.workspaceId)],
            ["limit", d.jsonString("100")],
            ["offset", d.jsonString(offset)],
            ["max_bytes", d.jsonString("1048576")],
            ["include_archived", d.jsonBoolean(true)],
            ...(revision === null ? [] : [["at_revision", d.jsonString(revision)] as const]),
          ]),
        },
        signal,
      );
      if (!result.ok) return result;
      const { data, meta } = result.data.response;
      const captured = d.decimal.decode(jsonField(meta, "workspace_revision"));
      const budget = jsonField(meta, "budget");
      const truncated = budget && jsonField(budget, "truncated");
      const items = jsonField(data, "items"),
        next = jsonField(data, "next_offset");
      const remaining = d.decimal.decode(jsonField(data, "remaining"));
      if (
        !captured.ok ||
        (revision !== null && revision !== captured.value) ||
        truncated?.kind !== "boolean" ||
        truncated.value ||
        items?.kind !== "array" ||
        !remaining.ok
      )
        return protocol("Workspace choices are incomplete or changed. Retry or enter an ID.");
      revision = captured.value;
      for (const item of items.items) {
        const id = d.identifier.decode(jsonField(item, `${kind}_id`));
        const details = kind === "resource" ? jsonField(item, "metadata") : item;
        const title = details && jsonField(details, "title");
        const archived = details && jsonField(details, "archived");
        if (
          !id.ok ||
          title?.kind !== "string" ||
          archived?.kind !== "boolean" ||
          rows.has(id.value)
        )
          return protocol("Workspace choices contain an invalid or repeated record.");
        rows.set(id.value, {
          id: id.value,
          title: title.value,
          detail: archived.value ? "Archived" : kind,
        });
      }
      if (next?.kind === "null") {
        if (remaining.value !== "0")
          return protocol("Workspace choices are incomplete. Retry or enter an ID.");
        return { ok: true, httpStatus: 200, data: [...rows.values()] };
      }
      const continuation = d.decimal.decode(next);
      if (
        !continuation.ok ||
        BigInt(continuation.value) <= BigInt(offset) ||
        items.items.length === 0
      )
        return protocol("Workspace choices did not advance.");
      offset = continuation.value;
    }
    return { ok: false, failure: { kind: "aborted" } };
  }

  if (kind === "session") {
    const client = createHistoryClient(http),
      target = {
        connectionId: scope.connection.id,
        generation: scope.connection.generation,
        workspaceId: scope.workspaceId,
      };
    let capture: HistoryCapture | null = null,
      offset = "0";
    const choices = new Map<string, ReferenceChoice>();
    while (!signal.aborted) {
      const result: HttpResult<Captured<DirectoryPage>> = await client.read(
        target,
        "session.list",
        capture === null ? { kind: "current" } : { kind: "pinned", head: capture.head },
        [
          ["include_archived", jsonBoolean(true)],
          ["limit", jsonString("100")],
          ["offset", jsonString(offset)],
          ["order", jsonString("session_id")],
        ],
        directoryPage,
        signal,
        "visible",
      );
      if (!result.ok) return result;
      if (capture !== null && !sameCapture(capture, result.data.capture))
        return protocol("Session choices changed capture. Retry or enter an ID.");
      capture = result.data.capture;
      for (const session of result.data.data.items) {
        if (session.workspace_id !== scope.workspaceId || choices.has(session.session_id))
          return protocol("Session choices repeated or changed workspace.");
        choices.set(session.session_id, {
          id: session.session_id,
          title: session.title,
          detail: `${session.actor_id} · ${session.archived ? "Archived" : "Open"}`,
        });
      }
      if (!result.data.data.has_more)
        return { ok: true, httpStatus: 200, data: [...choices.values()] };
      const next = result.data.data.next_offset;
      if (BigInt(next) <= BigInt(offset) || result.data.data.items.length === 0)
        return protocol("Session choices did not advance.");
      offset = next;
    }
    return { ok: false, failure: { kind: "aborted" } };
  }
  if (kind === "pool" || kind === "reservation") {
    const client = createCoordinationClient(http);
    let request = coordinationInvocation(
      workspace,
      kind === "pool" ? "allocation.pools" : "reservation.list",
      [
        ["limit", jsonString("100")],
        ["max_bytes", jsonString("1048576")],
      ],
    );
    const choices = new Map<string, ReferenceChoice>();
    while (!signal.aborted) {
      const result = await client.page(workspace, request, signal);
      if (!result.ok) return result;
      const page = result.data;
      for (const item of page.items) {
        let choice: ReferenceChoice;
        if (kind === "pool") {
          const decoded = poolCodec.decode(item);
          if (!decoded.ok)
            return protocol("A pool choice could not be read. Retry or enter a name.");
          choice = {
            id: decoded.value.name,
            title: decoded.value.name,
            detail: `${decoded.value.limit} concurrent ticket slots`,
          };
        } else {
          const decoded = reservationCodec("named").decode(item);
          if (!decoded.ok || decoded.value.target.kind !== "named")
            return protocol("A reservation choice could not be read. Retry or enter an ID.");
          choice = {
            id: decoded.value.target.reservation_id,
            title: decoded.value.target.reservation_id,
            detail: `${decoded.value.holders.length} recorded holders`,
          };
        }
        if (choices.has(choice.id)) return protocol("Coordination directory repeated an identity.");
        choices.set(choice.id, choice);
      }
      if (page.completeness === "complete")
        return { ok: true, httpStatus: 200, data: [...choices.values()] };
      if (page.continuation === null || page.completeness === "partial")
        return protocol("Coordination choices are incomplete. Retry or enter an ID.");
      request = page.continuation;
    }
    return { ok: false, failure: { kind: "aborted" } };
  }

  if (kind === "run" || kind === "attempt") {
    const target = { ...workspace, selection: { kind: "none" as const } };
    const client = createParticipantsClient(http);
    let request = participantInvocation(target, kind === "run" ? "run.list" : "attempt.list", [
      ["limit", jsonString("100")],
      ["max_bytes", jsonString("1048576")],
    ]);
    const choices = new Map<string, ReferenceChoice>();
    while (!signal.aborted) {
      const result = await client.page(target, request, signal);
      if (!result.ok) return result;
      const page = result.data;
      if (page.rows.kind !== "runs" && page.rows.kind !== "attempts")
        return protocol("Unexpected participant directory.");
      const items =
        page.rows.kind === "runs"
          ? page.rows.items.map((run) => ({
              id: run.run_id,
              title: run.objective || run.run_id,
              detail: `${run.actor_id} · ${run.status}`,
            }))
          : page.rows.items.map((attempt) => ({
              id: attempt.attempt_id,
              title: attempt.attempt_id,
              detail: `${attempt.ticket_id} · ${attempt.state} · ${attempt.run_id}`,
            }));
      for (const item of items) {
        if (choices.has(item.id)) return protocol("Participant directory repeated an identity.");
        choices.set(item.id, item);
      }
      if (page.completeness === "complete")
        return { ok: true, httpStatus: 200, data: [...choices.values()] };
      if (page.continuation === null || items.length === 0 || page.completeness === "partial")
        return protocol("Participant choices are incomplete. Retry or enter an ID.");
      request = page.continuation;
    }
    return { ok: false, failure: { kind: "aborted" } };
  }

  if (kind === "ticket") {
    const companion = createCompanion(http);
    const result = await readTicketCollection(
      { method: "ticket.list", params: queryParams(workspace, DEFAULT_WORK_FILTERS) },
      async (request) => {
        const response = await companion.read(
          {
            ...request,
            connection_id: scope.connection.id,
            generation: scope.connection.generation,
            lane: "visible",
          },
          signal,
        );
        if (!response.ok) return response;
        const budget = jsonField(response.data.response.meta, "budget");
        const truncated = budget === undefined ? undefined : jsonField(budget, "truncated");
        if (truncated?.kind !== "boolean" || truncated.value)
          return protocol("Ticket choices are incomplete. Retry or enter an ID.");
        const decoded = decodeCapture(
          response.data,
          listCodec,
          workspace,
          request.method,
          request.params,
        );
        return decoded.ok
          ? { ok: true, httpStatus: response.httpStatus, data: decoded.value }
          : {
              ok: false,
              failure: {
                kind: "protocol",
                message: "Ticket choices could not be decoded. You can still enter an ID.",
                issue: decoded.issue,
              },
            };
      },
      signal,
    );
    if (!result.ok) return result;
    if (
      result.data.controls.some((control) => !control.complete) ||
      result.data.value.next_offset !== null ||
      result.data.value.remaining !== "0"
    )
      return protocol("Ticket choices are incomplete. Retry or enter an ID.");
    return {
      ok: true,
      httpStatus: 200,
      data: result.data.value.items.map((ticket) => ({
        id: ticket.ticket_id,
        title: ticket.title,
        detail: `${ticket.display_key} · ${ticket.status.replaceAll("_", " ")}`,
      })),
    };
  }
  const endpoint = {
    connectionId: scope.connection.id,
    generation: scope.connection.generation,
    workspaceId: scope.workspaceId,
  };
  const selector: ThreadsRead =
    kind === "board"
      ? { kind: "boards", scope: null }
      : {
          kind: "threads",
          filter: {
            scope: null,
            boardId: "",
            actorId: "",
            status: "all",
            unresolved: false,
            text: "",
            pageSize: "25",
          },
        };
  let request = invocation(endpoint, selector);
  let revision: string | undefined;
  const rows = new Map<string, ReferenceChoice>();
  while (!signal.aborted) {
    const result = await read(http, endpoint, selector, request, signal);
    if (!result.ok) return result;
    const capture = result.data.captured;
    const current = jsonField(capture.response.response.meta, "query_revision");
    if (current?.kind !== "string" || (revision !== undefined && current.value !== revision))
      return protocol("Workspace choices changed while loading. Retry the list.");
    revision = current.value;
    const value = capture.value;
    if (value.kind !== "boards" && value.kind !== "threads")
      return protocol("Unexpected reference directory.");
    for (const item of value.page.items) {
      if (rows.has(item.id)) return protocol("Reference directory repeated an identity.");
      rows.set(item.id, {
        id: item.id,
        title: item.title,
        detail:
          "scope" in item
            ? item.scope.kind === "workspace"
              ? "Workspace board"
              : `Project ${item.scope.id}`
            : item.status.replaceAll("_", " "),
      });
    }
    if (value.page.nextOffset === null) {
      if (!complete(capture) || value.page.remaining !== "0")
        return protocol("Workspace choices are incomplete. Retry or enter an ID.");
      return { ok: true, httpStatus: 200, data: [...rows.values()] };
    }
    if (value.page.items.length === 0) return protocol("Reference directory did not advance.");
    const next = await continued(http, result.data, "next", signal);
    if (!next.ok) return next;
    request = next.data;
  }
  return { ok: false, failure: { kind: "aborted" } };
}
