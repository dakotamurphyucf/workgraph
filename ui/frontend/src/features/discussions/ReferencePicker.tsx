import { Icon } from "../../components/Icon";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { FeatureContext } from "../../app/types";
import { Button, Field } from "../../components/Primitives";
import { createReadSlot } from "../../core/state/read-slot";
import { failureText } from "../connections/failure";
import { workScopeKey } from "../work/read-model";
import {
  readReferenceChoices,
  type ReferenceChoice,
  type ReferenceKind,
} from "./reference-choices";
import type { Endpoint } from "./threads/types";

/** Selecting a reference changes only its field. Search never discards the draft
 * or silently replaces a manually entered ID that is absent from the directory. */
export function ReferencePicker({
  context,
  endpoint,
  kind,
  label,
  value,
  onChange,
  disabled = false,
}: {
  readonly context: FeatureContext;
  readonly endpoint: Endpoint;
  readonly kind: ReferenceKind;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  const [manual, setManual] = useState(false);
  const [query, setQuery] = useState("");
  const [slot] = useState(() => createReadSlot<readonly ReferenceChoice[]>());
  const state = useSyncExternalStore(slot.subscribe, slot.get);
  const scope = {
    connection: context.connection,
    workspaceId: endpoint.workspaceId,
    projectId: null,
  };
  const key = JSON.stringify([workScopeKey(scope), kind]);
  const matches =
    context.connection.id === endpoint.connectionId &&
    context.connection.generation === endpoint.generation &&
    context.route.workspaceId === endpoint.workspaceId;
  const load = () => {
    if (!matches || disabled) return;
    void slot
      .load(key, (signal) => readReferenceChoices(context.client, scope, kind, signal))
      .catch(() => {
        // Unexpected failures are retained by the slot and thrown to the feature boundary.
      });
  };
  useEffect(() => {
    load();
    return () => slot.clear();
    // Identity includes endpoint generation, socket, workspace and reference type.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, key, context.client, matches, disabled]);
  if (state.kind === "unexpected_error") throw state.error;
  const rows =
    matches && state.kind !== "idle" && state.key === key
      ? state.kind === "ready"
        ? state.value
        : state.previous
      : undefined;
  const matching = (rows ?? []).filter((row) =>
    `${row.title} ${row.id} ${row.detail}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const selected = rows?.find((row) => row.id === value);
  const noun = kind === "thread" ? "discussion" : kind;
  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
    trigger.current?.focus();
  };
  return (
    <div
      className="dc-reference-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <div className="dc-reference-label">
        <span>{label}</span>
        <Button
          type="button"
          tone="quiet"
          disabled={disabled}
          onClick={() => {
            setManual(!manual);
            setOpen(false);
          }}
        >
          {manual ? `Browse ${noun}s` : "Enter ID"}
        </Button>
      </div>
      {manual || !matches ? (
        <Field
          label={label}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <>
          <button
            ref={trigger}
            type="button"
            className="dc-reference-selection"
            aria-label={label}
            aria-expanded={open}
            aria-controls={panelId}
            disabled={disabled}
            onClick={() => {
              setOpen(!open);
              if (!open) {
                setQuery("");
                load();
              }
            }}
          >
            <Icon name={value ? "check" : "search"} />
            <span>
              <strong>{value ? selected?.title || value : `Choose a ${noun}…`}</strong>
              <small>
                {value
                  ? `${value}${selected?.detail ? ` · ${selected.detail}` : ""}`
                  : "Search workspace records by name or ID"}
              </small>
            </span>
            <Icon name="chevron" />
          </button>
          {open && (
            <section id={panelId} className="dc-reference-search" aria-label={`Choose ${noun}`}>
              <label className="wg-field">
                Search {noun}s
                <input
                  ref={search}
                  aria-label={`Search ${noun}s`}
                  placeholder="Type a name or ID…"
                  value={query}
                  disabled={disabled}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      event.currentTarget
                        .closest("section")
                        ?.querySelector<HTMLButtonElement>("[data-reference-option]")
                        ?.focus();
                    }
                  }}
                />
              </label>
              <div
                className="dc-reference-results"
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  const options = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "[data-reference-option]",
                    ),
                  ];
                  const index = options.findIndex((option) => option === document.activeElement);
                  event.preventDefault();
                  if (event.key === "ArrowUp" && index <= 0) search.current?.focus();
                  else
                    options[
                      Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))
                    ]?.focus();
                }}
              >
                {matching.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    data-reference-option
                    disabled={disabled}
                    aria-pressed={value === row.id}
                    onClick={() => choose(row.id)}
                  >
                    <Icon
                      name={value === row.id ? "check" : kind === "ticket" ? "work" : "discussions"}
                    />
                    <span>
                      <strong>{row.title || row.id}</strong>
                      <small>
                        {row.id} · {row.detail}
                      </small>
                    </span>
                    {value === row.id && (
                      <span className="dc-reference-selected-label">Selected</span>
                    )}
                  </button>
                ))}
                {rows !== undefined && matching.length === 0 && (
                  <p>No matching {noun}s. Try another search or enter an ID.</p>
                )}
              </div>
              <div className="dc-reference-search-actions">
                <Button type="button" tone="quiet" onClick={load}>
                  Refresh choices
                </Button>
                <Button
                  type="button"
                  tone="quiet"
                  onClick={() => {
                    setOpen(false);
                    trigger.current?.focus();
                  }}
                >
                  Close choices
                </Button>
              </div>
            </section>
          )}
          {value !== "" && !disabled && (
            <Button type="button" tone="quiet" onClick={() => choose("")}>
              Clear {noun}
            </Button>
          )}
        </>
      )}
      <p className="wg-hint">
        {!matches
          ? "This editor belongs to another workspace or connection version. Its saved IDs are preserved; reopen it in that workspace to browse choices."
          : disabled
            ? "This saved selection is fixed for this action."
            : state.kind === "failed"
              ? failureText(state.failure)
              : rows === undefined
                ? "Loading workspace choices… Manual ID entry remains available."
                : `${matching.length} matching ${kind === "thread" ? "discussions" : `${kind}s`} in this workspace. ${kind === "ticket" ? "Search by title, display key or ID." : "Names and IDs refer to existing records."}`}
      </p>
      {matches && !disabled && state.kind === "failed" && (
        <Button type="button" tone="quiet" onClick={load}>
          {state.kind === "failed" ? "Retry choices" : "Refresh choices"}
        </Button>
      )}
    </div>
  );
}
