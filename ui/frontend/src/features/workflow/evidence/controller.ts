import { jsonField } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import { refreshSlots, createReadSlot } from "../../../core/state/read-slot";
import { failureText } from "../../connections/failure";
import { READS, definition } from "./commands";
import { createEvidenceClient } from "./client";
import { continuation } from "./continuation";
import {
  EvidenceInputError,
  MAX_DRAFT_BYTES,
  MAX_DRAFTS,
  MAX_TOTAL_BYTES,
  identifier,
  initialInputs,
  inputBytes,
  parsedObject,
  preparation,
  sameTarget,
  target,
  targetKey,
} from "./model";
import type {
  EvidenceCapture,
  EvidenceController,
  EvidenceDraft,
  EvidenceOptions,
  EvidenceRead,
  EvidenceState,
  GateCapture,
} from "./types";
import type { Identifier, ReadResponse } from "../../../core/protocol/types";

const claimCodec = c.record({
  actor_id: d.identifier,
  run_id: c.nullable(d.identifier),
  token: d.positiveDecimal,
  lease: c.raw,
});

export function createEvidenceController({
  http,
  operations,
}: EvidenceOptions): EvidenceController {
  const api = createEvidenceClient(http),
    evidence = createReadSlot<EvidenceCapture>(),
    gate = createReadSlot<GateCapture>(),
    inspector = createReadSlot<ReadResponse>(),
    listeners = new Set<() => void>(),
    jobs = new Map<Identifier, AbortController>();
  let disposed = false,
    inspection = 0;
  let inspectOwner: AbortController | null = null,
    invocation: {
      method: EvidenceRead;
      params: import("../../../core/protocol/types").JsonObject;
    } | null = null;
  let state: EvidenceState = {
    target: null,
    evidence: evidence.get(),
    gate: gate.get(),
    inspector: inspector.get(),
    inspectorMethod: null,
    drafts: [],
    selectedDraft: null,
    issue: null,
    unexpected: null,
  };
  const publish = (patch: Partial<EvidenceState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const find = (id: Identifier) => state.drafts.find((draft) => draft.id === id);
  const patch = (id: Identifier, change: Partial<EvidenceDraft>) =>
    publish({
      drafts: Object.freeze(
        state.drafts.map((draft) =>
          draft.id === id ? Object.freeze({ ...draft, ...change }) : draft,
        ),
      ),
    });
  const fail = (id: Identifier | null, error: unknown) => {
    const failure =
      error instanceof EvidenceInputError ? { issue: error.message } : { unexpected: { error } };
    if (id === null) publish(failure);
    else patch(id, failure);
  };
  const room = (inputs: EvidenceDraft["inputs"], id: Identifier | null) => {
    const bytes = inputBytes(inputs);
    if (bytes > MAX_DRAFT_BYTES)
      throw new EvidenceInputError("This editor exceeds 4 MiB. The previous values were retained.");
    if (
      state.drafts.reduce(
        (sum, draft) => sum + (draft.id === id ? 0 : inputBytes(draft.inputs)),
        bytes,
      ) > MAX_TOTAL_BYTES
    )
      throw new EvidenceInputError(
        "Retained editors exceed 16 MiB. Close an unsent editor; admitted intentions remain in the shared operation shelf.",
      );
  };
  evidence.subscribe(() => publish({ evidence: evidence.get() }));
  gate.subscribe(() => publish({ gate: gate.get() }));
  inspector.subscribe(() => publish({ inspector: inspector.get() }));
  const refresh = async () => {
    const scope = state.target;
    if (disposed || scope === null) return;
    // Each slot owns current failures and suppresses superseded reads, including
    // same-target refreshes. Do not republish their rethrows as global failures.
    await Promise.all([
      evidence
        .load(targetKey(scope), (signal) => api.context(scope, signal), { live: true })
        .catch(() => {}),
      gate
        .load(targetKey(scope), (signal) => api.gate(scope, signal), { live: true })
        .catch(() => {}),
    ]);
  };
  const read = async (
    method: EvidenceRead,
    params: import("../../../core/protocol/types").JsonObject,
    scope = state.target,
  ) => {
    if (disposed || scope === null) return;
    invocation = { method, params };
    publish({ inspectorMethod: method });
    await inspector
      .load(`${targetKey(scope)}:${method}:${++inspection}`, (signal) =>
        api.read(scope, method, params, signal),
      )
      .catch(() => {}); // The inspector slot retains the owned unexpected failure.
  };
  return {
    refreshLive: (signal) => refreshSlots([evidence, gate, inspector], signal),
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select: async (context, ticketId) => {
      try {
        const scope = target(context, ticketId);
        if (state.target !== null && sameTarget(scope, state.target)) return;
        inspection++;
        inspectOwner?.abort();
        inspectOwner = null;
        invocation = null;
        inspector.clear();
        publish({ target: scope, inspectorMethod: null, issue: null, unexpected: null });
        await refresh();
      } catch (error: unknown) {
        fail(null, error);
      }
    },
    refresh,
    inspect: async (method, source) => {
      if (!READS.includes(method) || state.target === null) return;
      const scope = state.target,
        epoch = ++inspection,
        abort = new AbortController();
      inspectOwner?.abort();
      inspectOwner = abort;
      try {
        const params = await parsedObject(http.processing, source, abort.signal);
        if (
          disposed ||
          inspection !== epoch ||
          state.target === null ||
          !sameTarget(scope, state.target)
        )
          return;
        const supplied = jsonField(params, "workspace_id");
        if (supplied?.kind !== "string" || supplied.value !== scope.workspaceId)
          throw new EvidenceInputError("Inspection must name the captured workspace exactly.");
        await read(method, params, scope);
      } catch (error: unknown) {
        if (!disposed && inspection === epoch) fail(null, error);
      }
    },
    continueInspection: async (kind) => {
      if (state.inspector.kind !== "ready" || state.target === null || invocation === null) return;
      const scope = state.target,
        original = invocation,
        response = state.inspector.value,
        epoch = ++inspection,
        abort = new AbortController();
      inspectOwner?.abort();
      inspectOwner = abort;
      try {
        const params = await continuation(
          http.processing,
          scope,
          original.method,
          original.params,
          response,
          kind,
          abort.signal,
        );
        if (
          disposed ||
          abort.signal.aborted ||
          epoch !== inspection ||
          state.target === null ||
          !sameTarget(scope, state.target)
        )
          return;
        await read(original.method, params, scope);
      } catch (error: unknown) {
        if (!disposed && !abort.signal.aborted && epoch === inspection) fail(null, error);
      }
    },
    open: async (context, ticketId, method) => {
      let id: Identifier | null = null;
      try {
        if (disposed) return null;
        if (state.drafts.length >= MAX_DRAFTS)
          throw new EvidenceInputError(
            "At most 24 evidence editors may be retained. Close an unsent editor first.",
          );
        const scope = target(context, ticketId),
          writer = Object.freeze({
            actorId: identifier(context.writer.actorId ?? ""),
            runId: context.writer.runId === null ? null : identifier(context.writer.runId),
          });
        const base =
          state.evidence.kind === "ready" && sameTarget(scope, state.evidence.value.target)
            ? state.evidence.value
            : null;
        id = identifier(`evidence-${crypto.randomUUID()}`);
        const abort = new AbortController();
        jobs.set(id, abort);
        const draft: EvidenceDraft = Object.freeze({
          id,
          method,
          target: scope,
          writer,
          projectId: null,
          claim: null,
          base,
          inputs: Object.freeze({}),
          phase: { kind: "initializing" as const },
          issue: null,
          unexpected: null,
        });
        publish({
          drafts: Object.freeze([...state.drafts, draft]),
          selectedDraft: id,
          issue: null,
        });
        const ticket = await api.ticket(scope, abort.signal);
        if (disposed || abort.signal.aborted || find(id) === undefined) return null;
        if (!ticket.ok) throw new EvidenceInputError(failureText(ticket.failure));
        const rawClaim = jsonField(ticket.data, "claim"),
          decoded = rawClaim?.kind === "null" ? null : claimCodec.decode(rawClaim);
        if (decoded !== null && !decoded.ok)
          throw new EvidenceInputError("Ticket claim capture is malformed; no token was adopted.");
        const claim =
          decoded === null || !decoded.ok
            ? null
            : Object.freeze({
                actorId: decoded.value.actor_id,
                runId: decoded.value.run_id,
                token: decoded.value.token,
              });
        if (
          ["manifest.publish", "acceptance.assert", "review.submit"].includes(method) &&
          (claim === null || claim.actorId !== writer.actorId || claim.runId !== writer.runId)
        )
          throw new EvidenceInputError(
            "This action requires the actual current claimant and run. Selecting an observed claim token does not transfer ownership.",
          );
        let inputs = await initialInputs(http.processing, method, scope, base, abort.signal);
        if (method === "acceptance.assert" && claim !== null)
          inputs = Object.freeze({
            ...inputs,
            token: Object.freeze({ presence: "value" as const, text: claim.token }),
          });
        if (disposed || abort.signal.aborted || find(id) === undefined) return null;
        room(inputs, id);
        const project = c.nullable(d.identifier).decode(jsonField(ticket.data, "project_id"));
        if (!project.ok)
          throw new EvidenceInputError("Malformed actual ticket project membership.");
        patch(id, { inputs, claim, projectId: project.value, phase: { kind: "editing" } });
        return id;
      } catch (error: unknown) {
        if (id !== null)
          patch(id, {
            phase: {
              kind: "unavailable",
              message:
                error instanceof EvidenceInputError
                  ? error.message
                  : "An unexpected initialization failure occurred.",
            },
          });
        fail(id, error);
        return id;
      } finally {
        if (id !== null) {
          jobs.delete(id);
        }
      }
    },
    selectDraft: (id) => {
      if (find(id) !== undefined) publish({ selectedDraft: id });
    },
    edit: (id, name, input) => {
      const draft = find(id);
      if (
        draft?.phase.kind !== "editing" ||
        !definition(draft.method).fields.some((field) => field.name === name)
      )
        return;
      try {
        const inputs = Object.freeze({ ...draft.inputs, [name]: Object.freeze({ ...input }) });
        room(inputs, id);
        patch(id, { inputs, issue: null, unexpected: null });
      } catch (error: unknown) {
        fail(id, error);
      }
    },
    prepare: async (id) => {
      const draft = find(id);
      if (disposed || draft?.phase.kind !== "editing" || draft.inputs === undefined) return;
      const abort = new AbortController();
      jobs.set(id, abort);
      patch(id, { phase: { kind: "preparing" }, issue: null, unexpected: null });
      let admitted = false;
      try {
        const captured = await preparation(http.processing, draft, abort.signal);
        if (disposed || abort.signal.aborted || find(id)?.phase.kind !== "preparing") return;
        const result = await operations.register(captured);
        if (!result.ok) throw new EvidenceInputError(failureText(result.failure));
        admitted = true;
        patch(id, { phase: { kind: "registered", preparation: captured } });
        const prepared = await operations.act(id, "prepare");
        if (!prepared.ok) patch(id, { issue: failureText(prepared.failure) });
      } catch (error: unknown) {
        if (!disposed && !abort.signal.aborted) {
          if (!admitted) patch(id, { phase: { kind: "editing" } });
          fail(id, error);
        }
      } finally {
        if (jobs.get(id) === abort) jobs.delete(id);
      }
    },
    discard: (id) => {
      const draft = find(id);
      if (draft === undefined || draft.phase.kind === "preparing") return;
      jobs.get(id)?.abort();
      jobs.delete(id);
      publish({
        drafts: Object.freeze(state.drafts.filter((item) => item.id !== id)),
        selectedDraft: state.selectedDraft === id ? null : state.selectedDraft,
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      inspectOwner?.abort();
      for (const job of jobs.values()) job.abort();
      jobs.clear();
      evidence.dispose();
      gate.dispose();
      inspector.dispose();
      listeners.clear();
    },
  };
}
