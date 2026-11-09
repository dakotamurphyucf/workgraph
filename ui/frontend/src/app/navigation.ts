import * as d from "../core/protocol/decoders";
import type {
  DiscussionRouteTarget,
  FactRouteTarget,
  HistoryRouteTarget,
  NavigationItem,
  ParticipantsRouteTarget,
  PlanningRouteTarget,
  RequestsRouteTarget,
  ResourceRouteTarget,
  Route,
  RouteSection,
  ViewId,
} from "./types";

export const NAVIGATION: readonly NavigationItem[] = [
  {
    id: "overview",
    label: "Overview",
    icon: "overview",
    description: "Attention, readiness and project progress",
  },
  { id: "work", label: "Work", icon: "work", description: "Tickets, board and inspector" },
  {
    id: "workflow",
    label: "Workflow",
    icon: "workflow",
    description: "Dependencies and planning changes",
  },
  {
    id: "discussions",
    label: "Discussions",
    icon: "discussions",
    description: "Threads, questions and inbox",
  },
  {
    id: "participants",
    label: "Participants",
    icon: "participants",
    description: "Actors, runs and execution attempts",
  },
  {
    id: "history",
    label: "History",
    icon: "history",
    description: "Recorded sessions, events and source data",
  },
  {
    id: "resources",
    label: "Resources",
    icon: "resources",
    description: "Versioned documents and attachments",
  },
  {
    id: "saved",
    label: "Saved views",
    icon: "saved",
    description: "Personal views and verified renderers",
  },
  { id: "facts", label: "Facts", icon: "facts", description: "Stored values and revisions" },
  {
    id: "activity",
    label: "Activity",
    icon: "activity",
    description: "Recorded workspace changes",
  },
  {
    id: "advanced",
    label: "Advanced",
    icon: "advanced",
    description: "API capabilities and exact request details",
  },
];
export const EMPTY_ROUTE: Route = {
  view: "overview",
  connectionId: null,
  workspaceId: null,
  projectId: null,
  entityId: null,
};
export function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,96}(?![\s\S])/u.test(value);
}
export type RouteResult =
  { readonly ok: true; readonly route: Route } | { readonly ok: false; readonly message: string };
const keys = ["connection", "workspace", "project", "entity"] as const;
function historyTarget(params: URLSearchParams, view: ViewId): HistoryRouteTarget | null | false {
  const supplied =
    ["head", "event"].some((key) => params.has(key)) ||
    (view !== "discussions" && view !== "participants" && params.has("generation"));
  if (!supplied) return null;
  const generation = params.get("generation"),
    head = params.get("head"),
    sequence = params.get("event");
  if (
    view !== "history" ||
    !params.has("connection") ||
    !params.has("workspace") ||
    !params.has("entity") ||
    generation === null ||
    head === null ||
    !/^[1-9][0-9]{0,18}(?![\s\S])/u.test(generation) ||
    BigInt(generation) > 4611686018427387903n ||
    (head !== "empty" && !/^[a-f0-9]{64}(?![\s\S])/u.test(head)) ||
    (sequence !== null &&
      (head === "empty" ||
        !/^[1-9][0-9]{0,6}(?![\s\S])/u.test(sequence) ||
        BigInt(sequence) > 1000000n))
  )
    return false;
  return {
    generation,
    head: head === "empty" ? null : head,
    ...(sequence === null ? {} : { sequence }),
  };
}
const discussionKeys = [
  "discussion",
  "comment",
  "comment_revision",
  "consumer",
  "recipient_kind",
  "recipient",
  "after",
  "through",
  "message_ticket",
  "exclude_self",
  "notification",
] as const;
function counter(value: string | null, positive = false): value is string {
  return (
    value !== null &&
    /^(0|[1-9][0-9]{0,18})(?![\s\S])/u.test(value) &&
    BigInt(value) <= 4611686018427387903n &&
    (!positive || value !== "0")
  );
}
function discussionTarget(
  params: URLSearchParams,
  view: ViewId,
): DiscussionRouteTarget | null | false {
  const supplied =
    discussionKeys.some((key) => params.has(key)) ||
    (view === "discussions" && params.has("generation"));
  if (!supplied) return null;
  const generation = params.get("generation"),
    kind = params.get("discussion");
  if (
    view !== "discussions" ||
    !params.has("connection") ||
    !params.has("workspace") ||
    !counter(generation, true)
  )
    return false;
  const hasComment = params.has("comment") || params.has("comment_revision"),
    messageKeys = [
      "consumer",
      "recipient_kind",
      "recipient",
      "after",
      "through",
      "notification",
      "message_ticket",
      "exclude_self",
    ],
    hasMessage = messageKeys.some((key) => params.has(key));
  if (kind === "comment") {
    const revision = params.get("comment_revision");
    return params.has("entity") && !params.has("comment") && !hasMessage && counter(revision, true)
      ? { kind, generation, revision }
      : false;
  }
  if (kind === "board" || kind === "thread")
    return params.has("entity") && !hasComment && !hasMessage ? { kind, generation } : false;
  if (kind === "ticket") {
    if (!params.has("entity") || hasMessage) return false;
    if (!hasComment) return { kind, generation, comment: null };
    const id = params.get("comment"),
      revision = params.get("comment_revision");
    return id !== null && validIdentifier(id) && counter(revision, true)
      ? { kind, generation, comment: { id, revision } }
      : false;
  }
  if (kind !== "messages" || params.has("entity") || hasComment) return false;
  if (!hasMessage) return { kind, generation, capture: null };
  const consumerId = params.get("consumer"),
    recipientKind = params.get("recipient_kind"),
    recipientId = params.get("recipient"),
    after = params.get("after"),
    through = params.get("through"),
    ticketId = params.get("message_ticket"),
    excludeSelf = params.get("exclude_self"),
    notificationId = params.get("notification");
  if (
    consumerId === null ||
    !validIdentifier(consumerId) ||
    (recipientKind !== "actor" && recipientKind !== "run") ||
    recipientId === null ||
    !validIdentifier(recipientId) ||
    !counter(after) ||
    !counter(through) ||
    (ticketId !== null && !validIdentifier(ticketId)) ||
    (excludeSelf !== "true" && excludeSelf !== "false") ||
    BigInt(after) > BigInt(through) ||
    (notificationId !== null &&
      (!counter(notificationId, true) ||
        BigInt(notificationId) <= BigInt(after) ||
        BigInt(notificationId) > BigInt(through)))
  )
    return false;
  return {
    kind,
    generation,
    capture: {
      consumerId,
      recipient: { kind: recipientKind, id: recipientId },
      after,
      through,
      ticketId,
      excludeSelf: excludeSelf === "true",
      notificationId,
    },
  };
}
function participantsTarget(
  params: URLSearchParams,
  view: ViewId,
): ParticipantsRouteTarget | null | false {
  if (!params.has("participant") && !(view === "participants" && params.has("generation")))
    return null;
  const kind = params.get("participant"),
    generation = params.get("generation");
  return view === "participants" &&
    params.has("connection") &&
    params.has("workspace") &&
    params.has("entity") &&
    counter(generation, true) &&
    (kind === "actor" || kind === "run" || kind === "attempt")
    ? { kind, generation }
    : false;
}
const requestKeys = [
  "req_view",
  "req_generation",
  "req_id",
  "req_revision",
  "req_consumer",
  "req_recipient_kind",
  "req_recipient",
  "req_after",
  "req_through",
  "req_kinds",
  "req_ticket",
  "req_exclude_self",
  "req_notification",
  "req_entity_kind",
] as const;
const notificationKinds = [
  "thread_changed",
  "message_received",
  "request_created",
  "request_acknowledged",
  "request_accepted",
  "request_reassigned",
  "request_resolved",
  "request_cancelled",
  "request_updated",
] as const;
function requestsTarget(params: URLSearchParams, view: ViewId): RequestsRouteTarget | null | false {
  if (!requestKeys.some((key) => params.has(key))) return null;
  const kind = params.get("req_view"),
    generation = params.get("req_generation");
  if (
    view !== "discussions" ||
    !params.has("connection") ||
    !params.has("workspace") ||
    params.has("entity") ||
    !counter(generation, true)
  )
    return false;
  const admits = (allowed: readonly string[]) =>
    requestKeys.every(
      (key) => !params.has(key) || ["req_view", "req_generation", ...allowed].includes(key),
    );
  if (kind === "requests") return admits([]) ? { kind, generation } : false;
  if (kind === "request") {
    const requestId = params.get("req_id"),
      revision = params.get("req_revision");
    return admits(["req_id", "req_revision"]) &&
      requestId !== null &&
      validIdentifier(requestId) &&
      (revision === null || counter(revision, true))
      ? { kind, generation, requestId, revision }
      : false;
  }
  if (kind === "routing") {
    const entityKind = params.get("req_entity_kind"),
      id = params.get("req_id");
    if (!admits(["req_entity_kind", "req_id"])) return false;
    if (entityKind === null && id === null) return { kind, generation, entity: null };
    return (entityKind === "team" || entityKind === "subscription") &&
      id !== null &&
      validIdentifier(id)
      ? { kind, generation, entity: { kind: entityKind, id } }
      : false;
  }
  if (
    kind !== "inbox" ||
    !admits([
      "req_consumer",
      "req_recipient_kind",
      "req_recipient",
      "req_after",
      "req_through",
      "req_kinds",
      "req_ticket",
      "req_exclude_self",
      "req_notification",
    ])
  )
    return false;
  if (
    requestKeys.every((key) => key === "req_view" || key === "req_generation" || !params.has(key))
  )
    return { kind, generation, capture: null };
  const consumerId = params.get("req_consumer"),
    recipientKind = params.get("req_recipient_kind"),
    recipientId = params.get("req_recipient"),
    after = params.get("req_after"),
    through = params.get("req_through"),
    encodedKinds = params.get("req_kinds"),
    ticketId = params.get("req_ticket"),
    excludeSelf = params.get("req_exclude_self"),
    notificationId = params.get("req_notification");
  const kinds = encodedKinds === null ? null : encodedKinds === "" ? [] : encodedKinds.split(",");
  if (
    consumerId === null ||
    !validIdentifier(consumerId) ||
    (recipientKind !== "actor" && recipientKind !== "run") ||
    recipientId === null ||
    !validIdentifier(recipientId) ||
    !counter(after) ||
    !counter(through) ||
    BigInt(after) > BigInt(through) ||
    kinds === null ||
    kinds.length > 8 ||
    new Set(kinds).size !== kinds.length ||
    kinds.some((value) => !notificationKinds.some((kind) => kind === value)) ||
    (ticketId !== null && !validIdentifier(ticketId)) ||
    (excludeSelf !== "true" && excludeSelf !== "false") ||
    (notificationId !== null &&
      (!counter(notificationId, true) ||
        BigInt(notificationId) <= BigInt(after) ||
        BigInt(notificationId) > BigInt(through)))
  )
    return false;
  return {
    kind,
    generation,
    capture: {
      consumerId,
      recipient: { kind: recipientKind, id: recipientId },
      after,
      through,
      kinds,
      ticketId,
      excludeSelf: excludeSelf === "true",
      notificationId,
    },
  };
}
/** Links are local UI navigation only; never arbitrary URLs, sockets or executable content. */
const resourceKeys = ["resource_generation", "content_version", "content_digest"] as const;
function resourceTarget(params: URLSearchParams, view: ViewId): ResourceRouteTarget | null | false {
  if (!resourceKeys.some((key) => params.has(key))) return null;
  const generation = params.get("resource_generation"),
    version = params.get("content_version"),
    digest = params.get("content_digest");
  if (
    view !== "resources" ||
    !params.has("connection") ||
    !params.has("workspace") ||
    !params.has("entity") ||
    !counter(generation, true) ||
    (version !== null && !counter(version, true)) ||
    (digest !== null && (version === null || !/^[a-f0-9]{64}(?![\s\S])/u.test(digest)))
  )
    return false;
  return { generation, content: version === null ? null : { version, expectedDigest: digest } };
}
const planningKeys = ["planning_kind", "planning_generation"] as const;
function planningTarget(params: URLSearchParams, view: ViewId): PlanningRouteTarget | null | false {
  if (!planningKeys.some((key) => params.has(key))) return null;
  const kind = params.get("planning_kind"),
    generation = params.get("planning_generation");
  if (!params.has("connection") || !params.has("workspace") || !counter(generation, true))
    return false;
  if (kind === "workspace")
    return view === "overview" && !params.has("entity") && !params.has("project")
      ? { kind, generation }
      : false;
  if (kind === "project")
    return view === "overview" &&
      params.has("entity") &&
      params.get("project") === params.get("entity")
      ? { kind, generation }
      : false;
  if (kind === "milestone" || kind === "ticket")
    return view === (kind === "ticket" ? "work" : "overview") &&
      params.has("entity") &&
      !params.has("project")
      ? { kind, generation }
      : false;
  return false;
}
function workbenchTarget(
  params: URLSearchParams,
  view: ViewId,
): import("./types").WorkbenchRouteTarget | null | false {
  if (!params.has("work_generation") && !params.has("work_socket")) return null;
  const generation = params.get("work_generation"),
    socket = params.get("work_socket");
  const profile = d.connectionProfile.decode(
    d.jsonObject([
      ["id", d.jsonString(params.get("connection") ?? "")],
      ["generation", d.jsonString(generation ?? "")],
      ["label", d.jsonString("")],
      ["socket", d.jsonString(socket ?? "")],
    ]),
  );
  return (view === "work" || view === "workflow") &&
    params.has("connection") &&
    params.has("workspace") &&
    counter(generation, true) &&
    socket !== null &&
    new TextEncoder().encode(socket).byteLength <= 4096 &&
    profile.ok
    ? { generation, socket }
    : false;
}
const factKeys = [
  "fact_generation",
  "fact_scope",
  "fact_scope_id",
  "fact_key",
  "fact_mode",
  "fact_revision",
  "fact_at_revision",
] as const;
function factTarget(params: URLSearchParams, view: ViewId): FactRouteTarget | null | false {
  if (!factKeys.some((key) => params.has(key))) return null;
  const generation = params.get("fact_generation"),
    kind = params.get("fact_scope"),
    id = params.get("fact_scope_id"),
    key = params.get("fact_key"),
    mode = params.get("fact_mode"),
    revision = params.get("fact_revision"),
    at = params.get("fact_at_revision");
  const keyBytes = key === null ? new Uint8Array() : new TextEncoder().encode(key);
  if (
    view !== "facts" ||
    !params.has("connection") ||
    !params.has("workspace") ||
    params.has("entity") ||
    !counter(generation, true)
  )
    return false;
  if (kind !== "workspace" && kind !== "project" && kind !== "milestone" && kind !== "ticket")
    return false;
  if (kind === "workspace" ? id !== null : id === null || !validIdentifier(id)) return false;
  if (params.has("project") && (kind !== "project" || params.get("project") !== id)) return false;
  if (mode === "directory") {
    if (key !== null || revision !== null || at !== null) return false;
    return {
      generation,
      scope: kind === "workspace" ? { kind } : { kind, id: id! },
      key: null,
      factRevision: null,
      atRevision: null,
    };
  }
  if (
    key === null ||
    key === "" ||
    /^ +$/u.test(key) ||
    keyBytes.length > 128 ||
    new TextDecoder().decode(keyBytes) !== key ||
    Array.from(key).some((char) => {
      const code = char.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159);
    }) ||
    (mode !== "current" && mode !== "pinned") ||
    (mode === "current" ? revision !== null : !counter(revision, true)) ||
    (at !== null && !counter(at))
  )
    return false;
  return {
    generation,
    scope: kind === "workspace" ? { kind } : { kind, id: id! },
    key,
    factRevision: revision,
    atRevision: at,
  };
}
function sectionTarget(view: ViewId, value: string | null): RouteSection | null | false {
  if (value === null) return null;
  switch (view) {
    case "work":
      return value === "list" || value === "board" ? { view, value } : false;
    case "workflow":
      return value === "relationships" ||
        value === "graph" ||
        value === "templates" ||
        value === "drafts" ||
        value === "local-evidence"
        ? { view, value }
        : false;
    case "participants":
      return value === "records" ||
        value === "allocation" ||
        value === "reservations" ||
        value === "conditions" ||
        value === "recovery"
        ? { view, value }
        : false;
    case "history":
      return value === "sessions" || value === "search" || value === "usage" || value === "summary"
        ? { view, value }
        : false;
    case "activity":
    case "advanced":
    case "discussions":
    case "facts":
    case "overview":
    case "resources":
    case "saved":
      return false;
  }
}
export function parseRoute(hash: string): RouteResult {
  if (hash === "" || hash === "#" || hash === "#/") return { ok: true, route: EMPTY_ROUTE };
  const match = /^#\/([a-z]+)(?:\?([^#]*))?(?![\s\S])/u.exec(hash);
  if (!match) return { ok: false, message: "This link is not a Workgraph view." };
  const view = NAVIGATION.find((item) => item.id === match[1])?.id;
  if (!view) return { ok: false, message: "This Workgraph view is unavailable." };
  const params = new URLSearchParams(match[2] ?? "");
  for (const [key, value] of params) {
    if (
      !(
        [
          ...keys,
          "section",
          "generation",
          "head",
          "event",
          "participant",
          ...discussionKeys,
          ...requestKeys,
          ...resourceKeys,
          ...planningKeys,
          "work_generation",
          "work_socket",
          ...factKeys,
        ] as readonly string[]
      ).includes(key) ||
      params.getAll(key).length !== 1 ||
      (keys.some((name) => name === key) && !validIdentifier(value))
    )
      return { ok: false, message: "This link contains an invalid or repeated scope identifier." };
  }
  if (
    !params.has("connection") &&
    ["workspace", "project", "entity"].some((key) => params.has(key))
  )
    return { ok: false, message: "A scoped link must name its daemon connection." };
  if (params.has("project") && !params.has("workspace"))
    return { ok: false, message: "A project link must name its workspace." };
  const section = sectionTarget(view, params.get("section"));
  if (section === false)
    return { ok: false, message: "This section is not available in this view." };
  const history = historyTarget(params, view);
  if (history === false)
    return {
      ok: false,
      message:
        "This history link requires an exact generation and capture, with a valid optional event.",
    };
  const discussion = discussionTarget(params, view);
  if (discussion === false || (view === "discussions" && params.has("entity") && !discussion))
    return {
      ok: false,
      message: "This discussion link requires a tagged target and exact matching scope/capture.",
    };
  const participant = participantsTarget(params, view);
  if (
    participant === false ||
    (view === "participants" && params.has("entity") && participant === null)
  )
    return {
      ok: false,
      message:
        "This participant link requires an explicit target kind and exact endpoint generation.",
    };
  const requests = requestsTarget(params, view);
  const resource = resourceTarget(params, view);
  const planning = planningTarget(params, view);
  const fact = factTarget(params, view);
  const workbench = workbenchTarget(params, view);
  if (
    requests === false ||
    resource === false ||
    planning === false ||
    fact === false ||
    workbench === false ||
    [history, discussion, participant, requests, resource, planning, fact, workbench].filter(
      (value) => value !== null,
    ).length > 1
  )
    return { ok: false, message: "This link mixes targets or has an incomplete Requests capture." };
  return {
    ok: true,
    route: {
      view,
      connectionId: params.get("connection"),
      workspaceId: params.get("workspace"),
      projectId: params.get("project"),
      entityId: params.get("entity"),
      ...(section === null ? {} : { section }),
      ...(history === null ? {} : { history }),
      ...(discussion === null ? {} : { discussion }),
      ...(participant === null ? {} : { participant }),
      ...(requests === null ? {} : { requests }),
      ...(resource === null ? {} : { resource }),
      ...(planning === null ? {} : { planning }),
      ...(fact === null ? {} : { fact }),
      ...(workbench === null ? {} : { workbench }),
    },
  };
}
export function routeHref(route: Route): string {
  if (
    [
      route.history,
      route.discussion,
      route.participant,
      route.requests,
      route.resource,
      route.planning,
      route.fact,
      route.workbench,
    ].filter((target) => target !== undefined).length > 1
  )
    throw new Error("A route cannot combine immutable feature targets.");
  if (
    route.connectionId === null &&
    [route.workspaceId, route.projectId, route.entityId].some((id) => id !== null)
  )
    throw new Error("A scoped route requires an explicit connection.");
  if (route.projectId !== null && route.workspaceId === null)
    throw new Error("A project route requires its workspace.");
  const params = new URLSearchParams();
  for (const [key, value] of [
    ["connection", route.connectionId],
    ["workspace", route.workspaceId],
    ["project", route.projectId],
    ["entity", route.entityId],
  ] as const) {
    if (value !== null) {
      if (!validIdentifier(value))
        throw new Error("Cannot navigate to an invalid scope identifier.");
      params.set(key, value);
    }
  }
  if (route.history !== undefined) {
    params.set("generation", route.history.generation);
    params.set("head", route.history.head ?? "empty");
    if (route.history.sequence !== undefined) params.set("event", route.history.sequence);
    if (historyTarget(params, route.view) === false)
      throw new Error("Invalid exact history target.");
  }
  if (route.discussion !== undefined) {
    const target = route.discussion;
    params.set("generation", target.generation);
    params.set("discussion", target.kind);
    if (target.kind === "comment") params.set("comment_revision", target.revision);
    if (target.kind === "ticket" && target.comment !== null) {
      params.set("comment", target.comment.id);
      params.set("comment_revision", target.comment.revision);
    }
    if (target.kind === "messages" && target.capture !== null) {
      params.set("consumer", target.capture.consumerId);
      params.set("recipient_kind", target.capture.recipient.kind);
      params.set("recipient", target.capture.recipient.id);
      params.set("after", target.capture.after);
      params.set("through", target.capture.through);
      if (target.capture.ticketId !== null) params.set("message_ticket", target.capture.ticketId);
      params.set("exclude_self", String(target.capture.excludeSelf));
      if (target.capture.notificationId !== null)
        params.set("notification", target.capture.notificationId);
    }
    if (discussionTarget(params, route.view) === false)
      throw new Error("Invalid exact discussion target.");
  }
  if (route.participant !== undefined) {
    params.set("generation", route.participant.generation);
    params.set("participant", route.participant.kind);
    if (participantsTarget(params, route.view) === false)
      throw new Error("Invalid exact participant target.");
  }
  if (route.requests !== undefined) {
    const target = route.requests;
    params.set("req_view", target.kind);
    params.set("req_generation", target.generation);
    if (target.kind === "request") {
      params.set("req_id", target.requestId);
      if (target.revision !== null) params.set("req_revision", target.revision);
    }
    if (target.kind === "routing" && target.entity !== null) {
      params.set("req_entity_kind", target.entity.kind);
      params.set("req_id", target.entity.id);
    }
    if (target.kind === "inbox" && target.capture !== null) {
      const value = target.capture;
      params.set("req_consumer", value.consumerId);
      params.set("req_recipient_kind", value.recipient.kind);
      params.set("req_recipient", value.recipient.id);
      params.set("req_after", value.after);
      params.set("req_through", value.through);
      params.set("req_kinds", value.kinds.join(","));
      params.set("req_exclude_self", String(value.excludeSelf));
      if (value.ticketId !== null) params.set("req_ticket", value.ticketId);
      if (value.notificationId !== null) params.set("req_notification", value.notificationId);
    }
    if (requestsTarget(params, route.view) === false)
      throw new Error("Invalid exact Requests target.");
  }
  if (route.resource !== undefined) {
    params.set("resource_generation", route.resource.generation);
    if (route.resource.content !== null) {
      params.set("content_version", route.resource.content.version);
      if (route.resource.content.expectedDigest !== null)
        params.set("content_digest", route.resource.content.expectedDigest);
    }
    if (resourceTarget(params, route.view) === false)
      throw new Error("Invalid exact Resource target.");
  }
  if (route.workbench !== undefined) {
    params.set("work_generation", route.workbench.generation);
    params.set("work_socket", route.workbench.socket);
    if (workbenchTarget(params, route.view) === false)
      throw new Error("Invalid original workbench target.");
  }
  if (route.planning !== undefined) {
    params.set("planning_kind", route.planning.kind);
    params.set("planning_generation", route.planning.generation);
    if (planningTarget(params, route.view) === false)
      throw new Error("Invalid recorded planning target.");
  }
  if (route.fact !== undefined) {
    const target = route.fact;
    params.set("fact_generation", target.generation);
    params.set("fact_scope", target.scope.kind);
    if (target.scope.kind !== "workspace") params.set("fact_scope_id", target.scope.id);
    if (target.key !== null) params.set("fact_key", target.key);
    params.set(
      "fact_mode",
      target.key === null ? "directory" : target.factRevision === null ? "current" : "pinned",
    );
    if (target.factRevision !== null) params.set("fact_revision", target.factRevision);
    if (target.atRevision !== null) params.set("fact_at_revision", target.atRevision);
    if (factTarget(params, route.view) === false) throw new Error("Invalid exact Fact target.");
  }
  if (route.view === "participants" && route.entityId !== null && route.participant === undefined)
    throw new Error("A selected participant requires its explicit target kind.");
  if (route.view === "discussions" && route.entityId !== null && route.discussion === undefined)
    throw new Error("A selected discussion requires its explicit target kind.");
  if (route.section !== undefined) {
    if (
      route.section.view !== route.view ||
      sectionTarget(route.view, route.section.value) === false
    )
      throw new Error("A section must belong to its destination view.");
    params.set("section", route.section.value);
  }
  const query = params.toString();
  return `#/${route.view}${query ? `?${query}` : ""}`;
}
export function changeView(route: Route, view: ViewId): Route {
  return { ...clearHistoryTarget(route), view, entityId: null };
}
/** Choosing a new workspace/project leaves every old entity and capture behind. */
export function changeScope(
  route: Route,
  workspaceId: string | null,
  projectId: string | null,
): Route {
  return { ...clearHistoryTarget(route), workspaceId, projectId, entityId: null };
}
/** Connection changes clear endpoint-local scope. Writer selection remains independent. */
export function changeConnection(route: Route, connectionId: string | null): Route {
  return {
    ...clearHistoryTarget(route),
    connectionId,
    workspaceId: null,
    projectId: null,
    entityId: null,
  };
}

/** Explicit current navigation clears immutable feature targets. Kept under its
 * existing name so callers cannot leak a Discussion or Participants target. */
export function clearHistoryTarget(route: Route): Route {
  return {
    view: route.view,
    connectionId: route.connectionId,
    workspaceId: route.workspaceId,
    projectId: route.projectId,
    entityId: route.entityId,
  };
}
