import { Icon } from "../../../components/Icon";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { Button } from "../../../components/Primitives";
import type { Identifier } from "../../../core/protocol/types";
import type { PageRows } from "./types";

type TableRows = Extract<PageRows, { readonly kind: "actors" | "catalog" | "runs" | "attempts" }>;

/** These are workspace records, not a list of connected processes. Counts and
 * observations below belong only to the supplied captured page. */
export function ParticipantTable({
  rows,
  onOpen,
}: {
  readonly rows: TableRows;
  readonly onOpen: (kind: "actor" | "run" | "attempt", id: Identifier) => void;
}) {
  if (rows.items.length === 0)
    return (
      <div className="pt-empty">
        <Icon
          name={rows.kind === "actors" || rows.kind === "catalog" ? "participants" : "activity"}
        />
        <h3>
          No {rows.kind === "catalog" || rows.kind === "actors" ? "people or agents" : rows.kind} on
          this page
        </h3>
        <p>
          Use Record a change to register identities and work. If filters are active, try clearing
          them in Views & filters.
        </p>
      </div>
    );
  switch (rows.kind) {
    case "runs":
      return (
        <div className="pt-table-scroll">
          <table className="pt-table">
            <thead>
              <tr>
                <th>Run / actor</th>
                <th>Recorded state</th>
                <th>Objective</th>
                <th>Last observation</th>
                <th>Capabilities</th>
              </tr>
            </thead>
            <tbody>
              {rows.items.map((item) => (
                <tr key={item.run_id}>
                  <td>
                    <div className="pt-identity">
                      <ActorAvatar actor={item.actor_id} />
                      <div>
                        <Button tone="quiet" onClick={() => onOpen("run", item.run_id)}>
                          {item.run_id}
                        </Button>
                        <span>{item.actor_id}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="pt-state" data-state={item.status}>
                      <Icon
                        name={
                          item.status === "completed"
                            ? "check"
                            : item.status === "running"
                              ? "activity"
                              : item.status === "cancelled"
                                ? "close"
                                : "history"
                        }
                      />
                      {item.status}
                    </span>
                  </td>
                  <td className="pt-objective">
                    {item.objective}
                    <small>{item.session_associations.total} associated sessions</small>
                  </td>
                  <td>
                    <Observation value={item.last_observed_unix_ms} />
                  </td>
                  <td>
                    <div className="pt-capabilities">
                      {item.capabilities.length === 0 ? (
                        <span className="pt-muted">None declared</span>
                      ) : (
                        item.capabilities.map((capability) => (
                          <span className="pt-tag" key={capability}>
                            {capability}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "actors":
      return (
        <div className="pt-table-scroll">
          <table className="pt-table">
            <thead>
              <tr>
                <th>Person / agent</th>
                <th>Kind</th>
                <th>Retained activity</th>
                <th>Sources</th>
              </tr>
            </thead>
            <tbody>
              {rows.items.map((item) => (
                <tr key={item.actor_id}>
                  <td>
                    <div className="pt-identity">
                      <ActorAvatar actor={item.actor_id} />
                      <div>
                        <Button tone="quiet" onClick={() => onOpen("actor", item.actor_id)}>
                          {item.registration?.name ?? item.actor_id}
                        </Button>
                        <span>{item.actor_id}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="pt-kind" data-kind={item.registration?.kind ?? "author"}>
                      <Icon
                        name={item.registration?.kind === "agent" ? "connection" : "participants"}
                      />
                      {item.registration?.kind ?? "Unregistered author"}
                    </span>
                    {item.registration?.archived && <span className="pt-tag">Archived</span>}
                  </td>
                  <td>
                    {item.observed === null ? (
                      <span className="pt-muted">No retained authored activity</span>
                    ) : (
                      <>
                        Revisions {item.observed.first_revision}–{item.observed.last_revision}
                      </>
                    )}
                  </td>
                  <td>
                    <div className="pt-capabilities">
                      {item.sources.map((source) => (
                        <span className="pt-tag" key={source}>
                          {source}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "catalog":
      return (
        <div className="pt-table-scroll">
          <table className="pt-table">
            <thead>
              <tr>
                <th>Registered identity</th>
                <th>Kind</th>
                <th>Catalog state</th>
                <th>Revision</th>
              </tr>
            </thead>
            <tbody>
              {rows.items.map((item) => (
                <tr key={item.actor_id}>
                  <td>
                    <div className="pt-identity">
                      <ActorAvatar actor={item.actor_id} />
                      <div>
                        <Button tone="quiet" onClick={() => onOpen("actor", item.actor_id)}>
                          {item.name}
                        </Button>
                        <span>{item.actor_id}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="pt-kind" data-kind={item.kind}>
                      <Icon name={item.kind === "agent" ? "connection" : "participants"} />
                      {item.kind}
                    </span>
                  </td>
                  <td>
                    <span className="pt-tag">{item.archived ? "Archived" : "Registered"}</span>
                  </td>
                  <td>{item.revision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "attempts":
      return (
        <div className="pt-table-scroll">
          <table className="pt-table">
            <thead>
              <tr>
                <th>Attempt</th>
                <th>Recorded state</th>
                <th>Run</th>
                <th>Ticket</th>
                <th>Claim token</th>
              </tr>
            </thead>
            <tbody>
              {rows.items.map((item) => (
                <tr key={item.attempt_id}>
                  <td>
                    <Button tone="quiet" onClick={() => onOpen("attempt", item.attempt_id)}>
                      {item.attempt_id}
                    </Button>
                  </td>
                  <td>
                    <span className="pt-state" data-state={item.state}>
                      <Icon name={item.state === "completed" ? "check" : "activity"} />
                      {item.state}
                    </span>
                  </td>
                  <td>
                    <Button tone="quiet" onClick={() => onOpen("run", item.run_id)}>
                      {item.run_id}
                    </Button>
                  </td>
                  <td>{item.ticket_id}</td>
                  <td>{item.token}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function Observation({ value }: { readonly value: string | null }) {
  if (value === null) return <span className="pt-muted">Not recorded</span>;
  const millis = BigInt(value);
  if (millis > 8640000000000000n)
    return <span title={`${value} milliseconds since Unix epoch`}>Outside calendar range</span>;
  const date = new Date(Number(millis));
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
      <small>{date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</small>
    </time>
  );
}
