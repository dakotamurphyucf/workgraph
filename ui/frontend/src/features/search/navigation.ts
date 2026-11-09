import { parseRoute, routeHref, type RouteResult } from "../../app/navigation";
import type { Route } from "../../app/types";
import type { ConnectionProfile } from "../../core/protocol/types";
/** Only the typed fragment is consumed. A pasted host does not authenticate an endpoint. */
export function pastedRoute(source: string): RouteResult {
  const text = source.trim();
  if (new TextEncoder().encode(text).length > 8192)
    return { ok: false, message: "This link exceeds 8 KiB." };
  if (text.startsWith("#")) return parseRoute(text);
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return { ok: false, message: "Paste a Workgraph browser link or typed #/ view link." };
    return parseRoute(url.hash);
  } catch (error: unknown) {
    if (error instanceof TypeError)
      return { ok: false, message: "Paste a complete Workgraph browser link or #/ view link." };
    throw error;
  }
}
/** Deliberate endpoint reassignment preserves content pins; it proves no original endpoint identity. */
export function mapEndpoint(route: Route, profile: ConnectionProfile): Route {
  const mapped: Route = {
    ...route,
    connectionId: profile.id,
    ...(route.history ? { history: { ...route.history, generation: profile.generation } } : {}),
    ...(route.discussion
      ? { discussion: { ...route.discussion, generation: profile.generation } }
      : {}),
    ...(route.participant
      ? { participant: { ...route.participant, generation: profile.generation } }
      : {}),
    ...(route.requests ? { requests: { ...route.requests, generation: profile.generation } } : {}),
    ...(route.resource ? { resource: { ...route.resource, generation: profile.generation } } : {}),
    ...(route.planning ? { planning: { ...route.planning, generation: profile.generation } } : {}),
    ...(route.fact ? { fact: { ...route.fact, generation: profile.generation } } : {}),
  };
  routeHref(mapped);
  return mapped;
}
