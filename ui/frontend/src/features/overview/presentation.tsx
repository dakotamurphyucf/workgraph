import type { ReactNode } from "react";
import type { FeatureContext, Route } from "../../app/types";
import { routeHref } from "../../app/navigation";
import { JsonView, LazyDetails } from "../connections/shared";
import { failureText } from "../connections/failure";
import type { ReadState } from "../../core/state/read-slot";
import { current } from "./controller";
import { queryKey, sourceRoute } from "./model";
import type { Observation, OverviewScope, DigestItem, CoordinationRow } from "./types";
export function Read<T>({
  state,
  label,
  children,
  quiet = false,
}: {
  readonly quiet?: boolean;
  readonly state: ReadState<T>;
  readonly label: string;
  readonly children: (value: T) => ReactNode;
}) {
  if (state.kind === "unexpected_error") throw state.error;
  const value = current(state);
  return (
    <>
      {state.kind === "loading" && (!quiet || value === undefined) && (
        <p role="status">
          Loading {label}…{value === undefined ? "" : " Showing the previous capture."}
        </p>
      )}
      {state.kind === "failed" && (
        <p role="alert">
          {label}: {failureText(state.failure)}
          {value === undefined
            ? " No result is available."
            : " Previous capture retained; it is not fresh."}
        </p>
      )}
      {value === undefined ? (
        state.kind === "idle" ? (
          <p>{label} has not been loaded.</p>
        ) : null
      ) : (
        children(value)
      )}
    </>
  );
}
export function Link({ route, children }: { readonly route: Route; readonly children: ReactNode }) {
  return <a href={routeHref(route)}>{children}</a>;
}
export function Sources({
  scope,
  sources,
  item,
}: {
  readonly scope: OverviewScope;
  readonly sources: readonly import("../../core/protocol/types").JsonObject[];
  readonly item?: DigestItem;
}) {
  const links = sources
    .map((source) => ({ source, route: sourceRoute(scope, source, item) }))
    .filter((v) => v.route !== null);
  return (
    <div className="ov-links">
      {links.map((v, index) => (
        <Link key={index} route={v.route!}>
          {v.route!.workbench
            ? "Open ticket"
            : v.route!.planning
              ? `Open current ${v.route!.planning.kind}`
              : v.route!.requests
                ? v.route!.requests.kind === "request" && v.route!.requests.revision !== null
                  ? "Open request revision"
                  : "Open current request"
                : v.route!.discussion
                  ? "Open comment revision"
                  : v.route!.resource
                    ? "Open resource version"
                    : "Open participant"}
        </Link>
      ))}
    </div>
  );
}
export function Provenance<T>({
  observed,
  scope,
  context,
  label,
}: {
  readonly observed: Observation<T>;
  readonly scope: OverviewScope;
  readonly context: FeatureContext;
  readonly label: string;
}) {
  return (
    <LazyDetails summary={`${label} capture and raw response`}>
      <p>
        Connection {scope.connection.label} · generation {scope.connection.generation} · planning
        revision {observed.revision}.{" "}
        {observed.partial
          ? "This result includes bounded excerpts or an omitted tail."
          : "This returned page is complete under its stated query."}
      </p>
      <JsonView
        value={observed.response.response.data}
        label={`${label} raw`}
        identity={queryKey(scope, observed.invocation)}
        processing={context.client.processing}
        partial={observed.partial}
      />
      <JsonView
        value={observed.response.response.meta}
        label={`${label} metadata`}
        identity={`${queryKey(scope, observed.invocation)}:meta`}
        processing={context.client.processing}
      />
    </LazyDetails>
  );
}
export function CoordinationRows({
  rows,
  scope,
}: {
  readonly rows: readonly CoordinationRow[];
  readonly scope: OverviewScope;
}) {
  return (
    <ul className="ov-rows">
      {rows.map((row, index) => (
        <li key={index}>
          <strong>{row.title}</strong>
          <p>{row.description}</p>
          {row.readiness !== null && !row.readiness.ready && (
            <ul>
              {row.readiness.reasons.map((reason, i) => (
                <li key={i}>
                  {reason.fields
                    .filter((f) => ["kind", "message", "ticket_id"].includes(f.name))
                    .map((f) => (f.value.kind === "string" ? f.value.value : ""))
                    .filter(Boolean)
                    .join(" · ")}
                </li>
              ))}
            </ul>
          )}
          <Sources scope={scope} sources={[row.source]} />
        </li>
      ))}
    </ul>
  );
}
