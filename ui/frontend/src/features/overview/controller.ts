import type { FeatureContext } from "../../app/types";
import {
  refreshSlots,
  createReadSlot,
  type ReadSlot,
  type ReadState,
} from "../../core/state/read-slot";
import type { HttpResult } from "../../core/protocol/http";
import type { ReadInvocation } from "../../core/protocol/types";
import * as d from "../../core/protocol/decoders";
import { createOverviewClient, nextInvocation, continued } from "./client";
import {
  attentionInvocation,
  captureDigest,
  captureFilter,
  captureScope,
  coordinationInvocation,
  defaultAttention,
  defaultDigest,
  digestInvocation,
  OverviewInputError,
  queryKey,
  scopeKey,
  summaryInvocation,
} from "./model";
import type {
  ActivityDigest,
  DigestQuery,
  AttentionPage,
  CoordinationPage,
  Observation,
  OverviewController,
  OverviewControllerOptions,
  OverviewScope,
  OverviewState,
  OverviewSummary,
  ReadinessPage,
} from "./types";
export function current<T>(state: ReadState<T>): T | undefined {
  return state.kind === "ready" ? state.value : state.kind === "idle" ? undefined : state.previous;
}
function savedKey<T>(value: ReadState<T>): string | undefined {
  return value.kind === "idle" ? undefined : value.key;
}
export function createOverviewController({ http }: OverviewControllerOptions): OverviewController {
  const client = createOverviewClient(http),
    listeners = new Set<() => void>();
  const summary = createReadSlot<Observation<OverviewSummary>>(),
    coordination = createReadSlot<Observation<CoordinationPage>>(),
    questions = createReadSlot<Observation<CoordinationPage>>(),
    attention = createReadSlot<Observation<AttentionPage>>(),
    readiness = createReadSlot<Observation<ReadinessPage>>(),
    digest = createReadSlot<Observation<ActivityDigest>>(),
    liveActivity = createReadSlot<Observation<ActivityDigest>>();
  const slots = [summary, coordination, questions, attention, readiness, digest, liveActivity];
  let overviewRoute = false;
  let recentQuery: DigestQuery | null = null;
  let disposed = false,
    epoch = 0,
    scopeAbort = new AbortController(),
    waitAbort: AbortController | null = null;
  let refreshFlight: Promise<void> | null = null;
  let state: OverviewState = {
    refreshing: false,
    scope: null,
    currentProfile: true,
    summary: summary.get(),
    coordination: coordination.get(),
    questions: questions.get(),
    attention: attention.get(),
    readiness: readiness.get(),
    digest: digest.get(),
    liveActivity: [],
    liveActivityRead: liveActivity.get(),
    attentionFilter: defaultAttention,
    digestQuery: defaultDigest,
    waiting: false,
    issue: null,
  };
  const publish = (patch: Partial<OverviewState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const l of listeners) l();
  };
  summary.subscribe(() => publish({ summary: summary.get() }));
  coordination.subscribe(() => publish({ coordination: coordination.get() }));
  questions.subscribe(() => publish({ questions: questions.get() }));
  attention.subscribe(() => publish({ attention: attention.get() }));
  readiness.subscribe(() => publish({ readiness: readiness.get() }));
  digest.subscribe(() => publish({ digest: digest.get() }));
  liveActivity.subscribe(() => publish({ liveActivityRead: liveActivity.get() }));
  const selected = () => {
    if (state.scope === null) throw new OverviewInputError("Select a workspace.");
    return state.scope;
  };
  const input = (error: unknown) => {
    if (error instanceof OverviewInputError) {
      publish({ issue: { kind: "input", message: error.message } });
      return;
    }
    throw error;
  };
  function invalidate() {
    epoch++;
    scopeAbort.abort();
    scopeAbort = new AbortController();
    waitAbort?.abort();
    waitAbort = null;
    refreshFlight = null;
    publish({ waiting: false, refreshing: false });
  }
  async function run<T>(
    slot: ReadSlot<Observation<T>>,
    scope: OverviewScope,
    request: ReadInvocation,
    read: (signal: AbortSignal) => Promise<HttpResult<Observation<T>>>,
    extra?: AbortSignal,
    retainedKey?: string,
    previous?: Observation<T>,
  ): Promise<Observation<T> | null> {
    const owner = epoch,
      abort = scopeAbort.signal;
    const identity = retainedKey ?? queryKey(scope, request);
    try {
      const result = await slot.load(
        identity,
        async (signal) => {
          const combined = AbortSignal.any([
            signal,
            abort,
            ...(extra === undefined ? [] : [extra]),
          ]);
          const result = await read(combined);
          return combined.aborted ? { ok: false, failure: { kind: "aborted" } } : result;
        },
        {
          // Cancellation belongs to the slot as well as the transport. Otherwise
          // a canceled owner can publish an ordinary failed read on completion.
          signal: extra === undefined ? abort : AbortSignal.any([abort, extra]),
          ...(previous === undefined ? {} : { previous }),
          live:
            retainedKey === undefined &&
            !request.method.startsWith("attention.") &&
            request.method !== "activity.digest",
        },
      );
      const observed = slot.get();
      return owner === epoch &&
        !disposed &&
        !abort.aborted &&
        result.ok &&
        observed.kind === "ready" &&
        observed.value === result.data
        ? result.data
        : null;
    } catch {
      // ReadSlot already published the unexpected failure for its owner.
      return null;
    }
  }
  async function takeAttention(
    scope: OverviewScope,
    request: ReadInvocation,
    extra?: AbortSignal,
    retainedKey?: string,
  ) {
    const owner = epoch;
    const result = await run(
      attention,
      scope,
      request,
      (signal) => client.attention(scope, request, signal),
      extra,
      retainedKey,
    );
    if (result !== null && result.value.readiness !== null)
      await publishReadiness(scope, owner, result);
  }
  async function publishReadiness(
    scope: OverviewScope,
    owner: number,
    result: Observation<AttentionPage>,
  ) {
    const value = result.value.readiness;
    if (
      value === null ||
      disposed ||
      owner !== epoch ||
      state.scope === null ||
      scopeKey(state.scope) !== scopeKey(scope)
    )
      return;
    const projected: Observation<ReadinessPage> = Object.freeze({
      ...result,
      value,
      revision: value.revision,
      partial: value.hasMore || value.needsLargerBudget,
    });
    await run(readiness, scope, result.invocation, () =>
      Promise.resolve({
        ok: true,
        data: projected,
        httpStatus: 200,
      }),
    );
  }
  function fromCaptured(
    observed: Observation<AttentionPage>,
    options: { readonly wait?: boolean; readonly readinessCursor?: string } = {},
  ): ReadInvocation {
    const fields = observed.invocation.params.fields
      .filter(
        (f) => !["cursor", "readiness_cursor", "initial_readiness", "timeout_ms"].includes(f.name),
      )
      .map((f) => [f.name, f.value] as const);
    return Object.freeze({
      ...observed.invocation,
      method: options.wait ? "attention.wait" : "attention.read",
      lane: options.wait ? "wait" : "visible",
      params: d.jsonObject([
        ...fields,
        ["cursor", d.jsonString(observed.value.cursor)],
        ...(options.readinessCursor === undefined
          ? []
          : [["readiness_cursor", d.jsonString(options.readinessCursor)] as const]),
        ...(options.wait ? [["timeout_ms", d.jsonString("25000")] as const] : []),
      ]),
    });
  }
  function refresh(): Promise<void> {
    if (refreshFlight !== null) return refreshFlight;
    let scope: OverviewScope;
    try {
      scope = selected();
    } catch (error) {
      input(error);
      return Promise.resolve();
    }
    invalidate();
    const owner = epoch,
      ownerSignal = scopeAbort.signal,
      digestQuery = state.digestQuery;
    liveActivity.clear();
    publish({ issue: null, refreshing: true });
    const task = (async () => {
      // Durable observation is captured BEFORE all independently-current checks.
      await takeAttention(scope, attentionInvocation(scope, state.attentionFilter));
      if (disposed || owner !== epoch || ownerSignal.aborted) return;
      const checks = [
        () =>
          run(summary, scope, summaryInvocation(scope), (signal) =>
            client.summary(scope, summaryInvocation(scope), signal),
          ),
        () =>
          run(coordination, scope, coordinationInvocation(scope), (signal) =>
            client.coordination(scope, coordinationInvocation(scope), signal),
          ),
        () =>
          run(questions, scope, coordinationInvocation(scope, true), (signal) =>
            client.coordination(scope, coordinationInvocation(scope, true), signal),
          ),
        () => {
          if (state.digestQuery !== digestQuery) return Promise.resolve(null);
          // Overview starts with a bounded recent revision window instead of
          // replaying the first page of the workspace's entire lifetime. Publish
          // the real query so Activity's filters and continuations stay honest.
          const capture = current(summary.get());
          const query =
            overviewRoute &&
            (digestQuery === defaultDigest || digestQuery === recentQuery) &&
            capture !== undefined
              ? {
                  ...digestQuery,
                  after: (BigInt(capture.revision) > 100n
                    ? BigInt(capture.revision) - 100n
                    : 0n
                  ).toString(),
                  limit: "100",
                  maxBytes: "1048576",
                }
              : digestQuery;
          if (query !== digestQuery) recentQuery = query;
          publish({ digestQuery: query });
          const request = digestInvocation(scope, query);
          return run(
            digest,
            scope,
            request,
            (signal) => client.digest(scope, request, signal),
            undefined,
            undefined,
            query === recentQuery ? current(digest.get()) : undefined,
          );
        },
      ];
      // Each HTTP read uses the shared bounded processor for encoding and decoding.
      // Preserve room for shell work rather than admitting a burst or retrying busy reads.
      for (const check of checks) {
        if (disposed || owner !== epoch || ownerSignal.aborted) return;
        await check();
      }
    })().finally(() => {
      if (refreshFlight === task) {
        refreshFlight = null;
        publish({ refreshing: false });
      }
    });
    refreshFlight = task;
    return task;
  }
  return {
    refreshLive: async (signal) => {
      if (disposed || scopeAbort.signal.aborted || refreshFlight !== null || state.scope === null)
        return { ok: true };
      const scope = state.scope,
        query = state.digestQuery,
        owner = epoch,
        ownedSignal = AbortSignal.any([signal, scopeAbort.signal]);
      const result = await refreshSlots([summary, coordination, questions], ownedSignal);
      if (ownedSignal.aborted || owner !== epoch) return { ok: true };
      const baseline = current(digest.get());
      if (baseline === undefined || ownedSignal.aborted) return result;
      // The original page may start years ago. Repeating it cannot show newly
      // appended rows. Follow its head with separate bounded native captures.
      for (let page = 0; page < 4; page++) {
        if (ownedSignal.aborted || owner !== epoch || state.digestQuery !== query) break;
        const previous = current(liveActivity.get());
        const next = previous?.value.hasMore ? nextInvocation(previous) : null;
        if (next && !next.ok) return { ok: false };
        const request = next?.ok
          ? next.data
          : digestInvocation(scope, {
              ...query,
              after: previous?.value.capture.through ?? baseline.value.capture.through,
            });
        const loaded = await liveActivity.load(
          queryKey(scope, request),
          (readSignal) => client.digest(scope, request, readSignal),
          { signal: ownedSignal, background: true },
        );
        if (ownedSignal.aborted || owner !== epoch) return { ok: true };
        if (!loaded.ok) return { ok: false };
        if (ownedSignal.aborted || owner !== epoch || state.digestQuery !== query) break;
        if (loaded.data.value.entries.length > 0)
          publish({ liveActivity: [...state.liveActivity, loaded.data].slice(-8) });
        if (!loaded.data.value.hasMore) break;
      }
      return result;
    },
    get: () => state,
    subscribe(listener) {
      if (disposed) throw new Error("Overview controller disposed.");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async open(context: FeatureContext) {
      if (disposed) return;
      overviewRoute = context.route.view === "overview";
      if (context.route.workspaceId === null) {
        invalidate();
        for (const slot of slots) slot.clear();
        publish({ scope: null, currentProfile: context.profileState === "current", issue: null });
        return;
      }
      try {
        const scope = captureScope(context),
          changed = state.scope === null || scopeKey(state.scope) !== scopeKey(scope);
        publish({ currentProfile: context.profileState === "current" });
        if (!changed) {
          if (scopeAbort.signal.aborted) {
            scopeAbort = new AbortController();
            await refresh();
          }
          return;
        }
        invalidate();
        for (const slot of slots) slot.clear();
        publish({
          scope,
          attentionFilter: defaultAttention,
          digestQuery: defaultDigest,
          liveActivity: [],
          issue: null,
        });
        await refresh();
      } catch (error) {
        input(error);
      }
    },
    refresh,
    async setAttentionFilter(filter) {
      try {
        const captured = captureFilter(filter);
        invalidate();
        attention.clear();
        readiness.clear();
        publish({ attentionFilter: captured, issue: null });
        await refresh();
      } catch (error) {
        input(error);
      }
    },
    async nextAttention() {
      if (state.waiting || attention.get().kind === "loading") return;
      const captured = current(attention.get());
      if (captured === undefined || !captured.value.hasMore || captured.value.needsLargerBudget)
        return;
      await takeAttention(selected(), fromCaptured(captured), undefined, savedKey(attention.get()));
    },
    async nextReadiness() {
      if (readiness.get().kind === "loading") return;
      const observed = current(readiness.get()),
        changes = current(attention.get());
      if (
        observed === undefined ||
        changes === undefined ||
        !observed.value.hasMore ||
        observed.value.cursor === null ||
        observed.value.needsLargerBudget
      )
        return;
      const scope = selected(),
        request = fromCaptured(changes, { readinessCursor: observed.value.cursor });
      // Deliberately ignore this response's durable rows/cursor. They were NOT
      // displayed/consumed; the durable attention position remains unchanged.
      await run(readiness, scope, request, async (signal) => {
        const result = await client.attention(scope, request, signal);
        if (!result.ok) return result;
        const value = result.data.value.readiness;
        return value === null
          ? {
              ok: false,
              failure: {
                kind: "protocol",
                message: "Readiness continuation omitted its current snapshot.",
                issue: undefined,
              },
            }
          : {
              ok: true,
              data: {
                ...result.data,
                value,
                revision: value.revision,
                partial: value.hasMore || value.needsLargerBudget,
              },
              httpStatus: result.httpStatus,
            };
      });
    },
    async nextCoordination() {
      if (coordination.get().kind === "loading") return;
      const observed = current(coordination.get());
      if (observed === undefined || observed.value.cursor === null) return;
      const next = nextInvocation(observed);
      if (!next.ok) {
        publish({
          issue: {
            kind: "input",
            message: "Native continuation unavailable or changed. Refresh this capture explicitly.",
          },
        });
        return;
      }
      const scope = selected();
      await run(
        coordination,
        scope,
        next.data,
        async (signal) => continued(observed, await client.coordination(scope, next.data, signal)),
        undefined,
        savedKey(coordination.get()),
      );
    },
    async setDigestQuery(query) {
      try {
        const captured = captureDigest(query),
          scope = selected();
        liveActivity.clear();
        publish({ digestQuery: captured, issue: null, liveActivity: [] });
        const request = digestInvocation(scope, captured);
        await run(digest, scope, request, (signal) => client.digest(scope, request, signal));
      } catch (error) {
        input(error);
      }
    },
    async nextDigest() {
      if (digest.get().kind === "loading") return;
      const observed = current(digest.get());
      if (observed === undefined || !observed.value.hasMore) return;
      const next = nextInvocation(observed);
      if (!next.ok) {
        publish({
          issue: {
            kind: "input",
            message: "Native activity continuation changed. Refresh explicitly.",
          },
        });
        return;
      }
      const scope = selected();
      await run(
        digest,
        scope,
        next.data,
        async (signal) => continued(observed, await client.digest(scope, next.data, signal)),
        undefined,
        savedKey(digest.get()),
      );
    },
    async wait() {
      if (state.waiting || attention.get().kind === "loading") return;
      const observed = current(attention.get());
      if (observed === undefined || observed.value.hasMore || observed.value.needsLargerBudget) {
        publish({
          issue: { kind: "input", message: "Read every captured change page before waiting." },
        });
        return;
      }
      const scope = selected(),
        abort = new AbortController();
      waitAbort = abort;
      publish({ waiting: true, issue: null });
      try {
        await takeAttention(
          scope,
          fromCaptured(observed, { wait: true }),
          abort.signal,
          savedKey(attention.get()),
        );
      } finally {
        if (waitAbort === abort) {
          waitAbort = null;
          publish({ waiting: false });
        }
      }
    },
    stop() {
      waitAbort?.abort();
    },
    pause() {
      epoch++;
      scopeAbort.abort();
      refreshFlight = null;
      waitAbort?.abort();
      waitAbort = null;
      publish({ waiting: false, refreshing: false });
    },
    dispose() {
      if (disposed) return;
      invalidate();
      disposed = true;
      for (const slot of slots) slot.dispose();
      listeners.clear();
    },
  };
}
