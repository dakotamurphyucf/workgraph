import { type Companion, type OperationAction } from "../protocol/client";
import { createProtocolProcessor, type ProtocolProcessor } from "../protocol/worker";
import type { HttpFailure, HttpResult } from "../protocol/http";
import type { Identifier, Operation, Preparation } from "../protocol/types";
import { createProgressObserver, type ProgressStatus } from "./progress-observer";

export type ManagedAction = OperationAction | "prepare" | "inspect";
export type OperationPhase =
  | { readonly kind: "draft" }
  | { readonly kind: "pending"; readonly action: ManagedAction }
  | { readonly kind: "observed" }
  | { readonly kind: "unconfirmed"; readonly action: ManagedAction; readonly failure: HttpFailure }
  | { readonly kind: "unexpected_error"; readonly action: ManagedAction; readonly error: unknown };
export interface ManagedOperation {
  readonly preparation: Preparation;
  readonly operation: Operation | null;
  readonly phase: OperationPhase;
  /** Finite read-only progress for this original identity; absence means it was never started. */
  readonly observation?: ProgressStatus;
}
export type ManagedResult =
  | { readonly ok: true; readonly entry: ManagedOperation }
  | { readonly ok: false; readonly failure: HttpFailure };
export interface OperationController {
  readonly get: (intention: Identifier) => ManagedOperation | undefined;
  readonly list: () => readonly ManagedOperation[];
  readonly subscribe: (listener: () => void) => () => void;
  /** Copies/validates the complete draft once. A reused ID cannot silently change context. */
  readonly register: (preparation: Preparation) => Promise<ManagedResult>;
  /** Observe a validated server operation, for example after reloading its journal list. */
  readonly adopt: (operation: Operation) => Promise<ManagedResult>;
  /** No automatic execution, retries or receipt recovery. Each action is explicit. */
  readonly act: (intention: Identifier, action: ManagedAction) => Promise<ManagedResult>;
  /** Ends only browser-owned observation reads; admitted daemon work is unaffected. */
  readonly dispose: () => void;
}

function invalid(message: string): ManagedResult {
  return { ok: false, failure: { kind: "input", message } };
}
function older(left: string, right: string): boolean {
  return left.length < right.length || (left.length === right.length && left < right);
}
/** One browser owner. Pending actions outlive navigation and retain the original writer. */
export function createOperationController(
  client: Companion,
  processing?: ProtocolProcessor,
): OperationController {
  const processor = processing ?? createProtocolProcessor();
  const entries = new Map<Identifier, ManagedOperation>();
  const identities = new Map<Identifier, string>();
  const observations = new Map<
    Identifier,
    { readonly request: string; readonly receipt: string | null }
  >();
  const active = new Map<
    Identifier,
    { readonly action: ManagedAction; readonly promise: Promise<ManagedResult> }
  >();
  const listeners = new Set<() => void>();
  const progress = createProgressObserver();
  let disposed = false;
  const publish = (id: Identifier, entry: ManagedOperation): void => {
    entries.set(id, Object.freeze(entry));
    for (const listener of listeners) listener();
  };
  function install(preparation: Preparation, identity: string): ManagedResult {
    const id = preparation.intention_id;
    // Recheck after asynchronous validation: two admissions cannot overwrite one identity.
    const previous = entries.get(id);
    if (previous !== undefined)
      return identities.get(id) === identity
        ? { ok: true, entry: previous }
        : invalid(
            "This intention already belongs to a different captured preparation. Create a new draft explicitly.",
          );
    const entry: ManagedOperation = { preparation, operation: null, phase: { kind: "draft" } };
    identities.set(id, identity);
    publish(id, entry);
    return { ok: true, entry };
  }
  const register = async (preparation: Preparation): Promise<ManagedResult> => {
    if (disposed) return invalid("This browser launch has ended.");
    // Processor captures metadata and bounded ordinary/certified parameters synchronously before this await.
    const result = await processor.admitPreparation(preparation);
    if (disposed) return invalid("This browser launch has ended.");
    if (!result.ok)
      return result.failure.kind === "aborted"
        ? { ok: false, failure: { kind: "aborted" } }
        : invalid(result.failure.message);
    if (!result.value.ok) return invalid(result.value.message);
    return install(result.value.preparation, result.value.identity);
  };
  const adopt = async (
    input: Operation,
    current: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<ManagedResult> => {
    if (disposed) return invalid("This browser launch has ended.");
    const result = await processor.observeOperation(
      input,
      signal === undefined ? undefined : { signal },
    );
    if (disposed || !current()) return { ok: false, failure: { kind: "aborted" } };
    if (!result.ok)
      return result.failure.kind === "aborted"
        ? { ok: false, failure: { kind: "aborted" } }
        : invalid(result.failure.message);
    if (!result.value.ok) return invalid(result.value.message);
    const observed = result.value;
    const operation = observed.operation;
    const snapshot = operation.preparation;
    const registered = install(
      {
        intention_id: snapshot.intention_id,
        context: snapshot.context,
        connection_id: snapshot.connection.id,
        generation: snapshot.connection.generation,
        method: snapshot.method,
        params: snapshot.params,
      },
      observed.preparationIdentity,
    );
    if (!registered.ok) return registered;
    // Latest entry is read only after worker settlement; delayed old observations cannot regress it.
    const previous = registered.entry.operation;
    const fingerprint = observations.get(snapshot.intention_id);
    if (previous !== null) {
      if (
        previous.operation_id !== operation.operation_id ||
        previous.preparation_input_hash !== operation.preparation_input_hash ||
        previous.journal_path !== operation.journal_path ||
        previous.receipt_lookup_supported !== operation.receipt_lookup_supported ||
        previous.connection.label !== operation.connection.label ||
        previous.connection.socket !== operation.connection.socket ||
        fingerprint?.request !== observed.requestIdentity
      )
        return invalid("Server observation changed the operation identity.");
      if (older(operation.revision, previous.revision))
        return invalid("Server returned an older operation observation; refresh its state.");
      if (operation.revision === previous.revision && operation.state.kind !== previous.state.kind)
        return invalid("One operation revision cannot describe two different states.");
      if (
        (previous.state.kind === "committed" ||
          (previous.state.kind === "observed" &&
            previous.preparation.method !== "ticket.claim_next")) &&
        operation.state.kind !== previous.state.kind
      )
        return invalid("An observed result cannot become an uncertain or different outcome.");
      if (
        (previous.state.kind === "committed" || previous.state.kind === "observed") &&
        operation.state.kind === previous.state.kind &&
        fingerprint?.receipt !== observed.receiptIdentity &&
        !(
          previous.state.kind === "observed" &&
          previous.preparation.method === "ticket.claim_next" &&
          older(previous.revision, operation.revision)
        )
      )
        return invalid("A recorded result changed without a permitted new observation.");
    }
    const entry: ManagedOperation = {
      ...registered.entry,
      operation,
      phase: { kind: "observed" },
    };
    observations.set(snapshot.intention_id, {
      request: observed.requestIdentity,
      receipt: observed.receiptIdentity,
    });
    publish(snapshot.intention_id, entry);
    return { ok: true, entry };
  };
  const invoke = (
    entry: ManagedOperation,
    action: ManagedAction,
  ): Promise<HttpResult<Operation>> => {
    if (action === "prepare") return client.prepare(entry.preparation);
    if (entry.operation === null) throw new Error("Only prepared operations reach invocation.");
    if (action === "inspect") return client.inspect(entry.operation.operation_id);
    return client.act(entry.operation.operation_id, action);
  };
  const observeSending = (id: Identifier, captured: Operation): void => {
    progress.start(id, {
      changed: (observation) => {
        const latest = entries.get(id);
        if (latest !== undefined) publish(id, { ...latest, observation });
      },
      unexpected: (error) => {
        const latest = entries.get(id);
        if (latest !== undefined)
          publish(id, { ...latest, phase: { kind: "unexpected_error", action: "inspect", error } });
      },
      inspect: async (signal) => {
        const latest = entries.get(id);
        if (latest?.operation?.operation_id !== captured.operation_id) return "unknown";
        if (latest.operation.state.kind !== "sending")
          return latest.operation.state.kind === "outcome_unknown" ? "unknown" : "complete";
        if (active.has(id)) return "pending";
        const result = await client.inspect(captured.operation_id, signal);
        if (signal.aborted) return "unknown";
        const newer = entries.get(id)?.operation;
        if (newer !== undefined && newer !== null && newer.state.kind !== "sending")
          return newer.state.kind === "outcome_unknown" ? "unknown" : "complete";
        if (!result.ok) {
          publish(id, {
            ...(entries.get(id) ?? latest),
            phase: { kind: "unconfirmed", action: "inspect", failure: result.failure },
          });
          return "error";
        }
        if (result.data.preparation.intention_id !== id) return "error";
        const adopted = await adopt(
          result.data,
          () => !signal.aborted && entries.get(id)?.operation?.state.kind === "sending",
          signal,
        );
        if (signal.aborted) return "unknown";
        if (!adopted.ok) {
          // Another valid observer may have advanced the journal during worker validation.
          const current = entries.get(id)?.operation;
          if (current && older(result.data.revision, current.revision))
            return current.state.kind === "sending"
              ? "pending"
              : current.state.kind === "outcome_unknown"
                ? "unknown"
                : "complete";
          publish(id, {
            ...(entries.get(id) ?? latest),
            phase: { kind: "unconfirmed", action: "inspect", failure: adopted.failure },
          });
          return "error";
        }
        return adopted.entry.operation?.state.kind === "sending"
          ? "pending"
          : adopted.entry.operation?.state.kind === "outcome_unknown"
            ? "unknown"
            : "complete";
      },
    });
  };
  return {
    get: (id) => entries.get(id),
    list: () => Object.freeze([...entries.values()]),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register,
    adopt,
    act: (id, action) => {
      if (disposed) return Promise.resolve(invalid("This browser launch has ended."));
      const pending = active.get(id);
      if (pending !== undefined)
        return pending.action === action
          ? pending.promise
          : Promise.resolve(invalid("Another action for this intention is still pending."));
      const entry = entries.get(id);
      if (entry === undefined)
        return Promise.resolve(invalid("Register the captured draft before acting."));
      if (action !== "prepare" && entry.operation === null)
        return Promise.resolve(
          invalid("Preparation is not confirmed. Recover the same preparation before executing."),
        );
      if (action === "recover" && entry.operation?.receipt_lookup_supported !== true)
        return Promise.resolve(
          invalid(
            "This operation has no public receipt lookup. Inspect its state or explicitly retry the saved request when supported.",
          ),
        );
      // An explicit action supersedes a background read, never an admitted daemon write.
      progress.stop(id);
      // The first microtask runs only after the active record is installed. This
      // coalesces double-clicks even if a test/client resolves synchronously.
      const promise = Promise.resolve().then(async (): Promise<ManagedResult> => {
        publish(id, { ...(entries.get(id) ?? entry), phase: { kind: "pending", action } });
        try {
          const result = await invoke(entry, action);
          if (!result.ok) {
            const latest = entries.get(id) ?? entry;
            publish(id, {
              ...latest,
              phase: { kind: "unconfirmed", action, failure: result.failure },
            });
            return result;
          }
          if (result.data.preparation.intention_id !== id) {
            const failure: HttpFailure = {
              kind: "protocol",
              message: "Response names a different intention.",
              issue: undefined,
            };
            publish(id, {
              ...(entries.get(id) ?? entry),
              phase: { kind: "unconfirmed", action, failure },
            });
            return { ok: false, failure };
          }
          const adopted = await adopt(result.data);
          if (!adopted.ok)
            publish(id, {
              ...(entries.get(id) ?? entry),
              phase: { kind: "unconfirmed", action, failure: adopted.failure },
            });
          else if (adopted.entry.operation?.state.kind === "sending")
            observeSending(id, adopted.entry.operation);
          return adopted;
        } catch (error: unknown) {
          publish(id, {
            ...(entries.get(id) ?? entry),
            phase: { kind: "unexpected_error", action, error },
          });
          throw error;
        } finally {
          active.delete(id);
        }
      });
      active.set(id, { action, promise });
      return promise;
    },
    dispose: () => {
      disposed = true;
      progress.dispose();
      if (processing === undefined) processor.dispose();
    },
  };
}
