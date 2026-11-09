import { jsonField } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import { preparationJson } from "../../../core/protocol/client";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type {
  Identifier,
  Preparation,
  Decimal,
  JsonObject,
  Problem,
  ConnectionProfile,
} from "../../../core/protocol/types";
import { invalid } from "./client";
import { choice } from "./codecs";
import { CoordinationInputError, counter } from "./model";
import type { WaitJob, WaitLimits } from "./types";

type NativeState =
  | { readonly kind: "prepared_unsent" | "canceled_unsent" }
  | { readonly kind: "running"; readonly attempts: Decimal; readonly latest_journal: string }
  | { readonly kind: "completed" | "stopped"; readonly outcome: JsonObject }
  | {
      readonly kind: "outcome_unknown";
      readonly problem: Problem;
      readonly exact_journal: string;
      readonly exchange_started: boolean;
      readonly outcome: JsonObject | null;
    };
const nativeState = c.tagged<NativeState>("kind", {
  prepared_unsent: c.record({ kind: c.literal("prepared_unsent") }),
  canceled_unsent: c.record({ kind: c.literal("canceled_unsent") }),
  running: c.record({ kind: c.literal("running"), attempts: d.decimal, latest_journal: c.text }),
  completed: c.record({ kind: c.literal("completed"), outcome: c.object }),
  stopped: c.record({ kind: c.literal("stopped"), outcome: c.object }),
  outcome_unknown: c.record({
    kind: c.literal("outcome_unknown"),
    problem: d.problem,
    exact_journal: c.text,
    exchange_started: c.boolean,
    outcome: c.nullable(c.object),
  }),
});
const rawJob = c.record({
  id: d.identifier,
  input_hash: d.digest,
  preparation: d.preparationSnapshot,
  limits: c.record({
    timeout_ms: d.positiveDecimal,
    max_attempts: d.positiveDecimal,
    wait_slice_ms: d.positiveDecimal,
  }),
  revision: d.positiveDecimal,
  cancel_requested: c.boolean,
  state: nativeState,
  diagnostic: c.nullable(d.problem),
});
export const waitJob: c.Codec<WaitJob> = {
  decode(value, path = []) {
    const result = rawJob.decode(value, path);
    if (!result.ok) return result;
    const v = result.value,
      s = v.state;
    if (
      v.id !== v.preparation.intention_id ||
      !["reservation.acquire", "reservation.paths.acquire"].includes(v.preparation.method) ||
      BigInt(v.limits.timeout_ms) < 1000n ||
      BigInt(v.limits.timeout_ms) > 300000n ||
      BigInt(v.limits.max_attempts) > 100n ||
      BigInt(v.limits.wait_slice_ms) > 25000n
    )
      return c.mismatch(path, "bounded reservation-wait job with matching original identity");
    if (s.kind === "running" && BigInt(s.attempts) > 100n)
      return c.mismatch(path, "at most 100 native acquisition journals");
    if (s.kind === "completed" || s.kind === "stopped") {
      const data = jsonField(s.outcome, "data"),
        wait = data === undefined ? undefined : jsonField(data, "wait");
      const check = c
        .record({
          completed: c.boolean,
          stop: choice([
            "acquired",
            "deadline",
            "attempt_limit",
            "needs_larger_budget",
            "no_progress",
            "failed",
            "canceled",
          ]),
          attempt_count: d.decimal,
          journals: c.array(
            c.record({ mutation_id: d.identifier, saved_request: c.text, started: c.boolean }),
            100,
          ),
          last_conflict: c.nullable(d.problem),
          problem: c.nullable(d.problem),
          feed_response: c.nullable(d.publicResponse),
          saved_request: c.nullable(c.text),
          retry_request: c.nullable(c.object),
        })
        .decode(wait);
      if (
        !check.ok ||
        check.value.completed !== (s.kind === "completed") ||
        (check.value.stop === "acquired") !== check.value.completed ||
        BigInt(check.value.attempt_count) !==
          BigInt(check.value.journals.filter((journal) => journal.started).length)
      )
        return c.mismatch(
          path,
          "native outcome agreeing with completion and bounded journal count",
        );
      if (
        BigInt(check.value.journals.length) > BigInt(v.limits.max_attempts) ||
        new Set(check.value.journals.map((journal) => journal.mutation_id)).size !==
          check.value.journals.length
      )
        return c.mismatch(path, "distinct original journals within the explicit attempt bound");
      if (s.kind === "completed") {
        const response = data === undefined ? undefined : jsonField(data, "daemon_response"),
          decoded = d.publicResponse.decode(response);
        const durable = decoded.ok ? jsonField(decoded.value.meta, "durable") : undefined;
        if (!decoded.ok || durable?.kind !== "boolean" || !durable.value)
          return c.mismatch(path, "explicit durable native grant");
      }
    }
    const state: WaitJob["state"] =
      s.kind === "running"
        ? { kind: s.kind, attempts: s.attempts, latestJournal: s.latest_journal }
        : s.kind === "outcome_unknown"
          ? {
              kind: s.kind,
              problem: s.problem,
              exactJournal: s.exact_journal,
              exchangeStarted: s.exchange_started,
              outcome: s.outcome,
            }
          : s;
    return {
      ok: true,
      value: Object.freeze({
        id: v.id,
        inputHash: v.input_hash,
        preparation: v.preparation,
        limits: {
          timeoutMs: v.limits.timeout_ms,
          maxAttempts: v.limits.max_attempts,
          waitSliceMs: v.limits.wait_slice_ms,
        },
        revision: v.revision,
        cancelRequested: v.cancel_requested,
        state: Object.freeze(state),
        diagnostic: v.diagnostic,
      }),
    };
  },
};
export interface WaitListPage {
  readonly items: readonly WaitJob[];
  readonly offset: Decimal;
  readonly remaining: Decimal;
  readonly next_offset: Decimal | null;
}
export function waitPage(offset: Decimal): c.Codec<WaitListPage> {
  return {
    decode(value, path = []) {
      const result = c
        .record({
          items: c.array(waitJob, 1),
          offset: d.decimal,
          remaining: d.decimal,
          next_offset: c.nullable(d.decimal),
        })
        .decode(value, path);
      if (!result.ok) return result;
      const page = result.value;
      if (
        page.offset !== offset ||
        BigInt(page.remaining) > 100n ||
        (page.remaining === "0") !== (page.next_offset === null) ||
        (page.next_offset !== null &&
          (page.items.length !== 1 || BigInt(page.next_offset) !== BigInt(offset) + 1n))
      )
        return c.mismatch(
          path,
          "matching one-job page with an advancing continuation and exact remaining count",
        );
      return result;
    },
  };
}
export function createWaitClient(http: HttpClient) {
  const inspect = (id: Identifier, signal?: AbortSignal) =>
    http.request({
      path: `/reservation-waits/${encodeURIComponent(id)}`,
      method: "GET",
      codec: waitJob,
      responseBudget: "operation",
      ...(signal === undefined ? {} : { signal }),
    });
  return {
    inspect,
    list: (offset: Decimal, signal?: AbortSignal) =>
      http.request({
        path: `/reservation-waits?offset=${offset}&limit=1`,
        method: "GET",
        responseBudget: "operation",
        codec: waitPage(offset),
        ...(signal === undefined ? {} : { signal }),
      }),
    prepare: async (
      preparation: Preparation,
      suppliedLimits: WaitLimits,
      suppliedConnection: ConnectionProfile,
    ): Promise<HttpResult<WaitJob>> => {
      const limits = Object.freeze({ ...suppliedLimits });
      const expectedConnection = Object.freeze({ ...suppliedConnection });
      if (
        preparation.connection_id !== expectedConnection.id ||
        preparation.generation !== expectedConnection.generation
      )
        throw new CoordinationInputError(
          "Wait preparation differs from its captured endpoint generation.",
        );
      counter(limits.timeoutMs, 300000n, 1000n);
      counter(limits.maxAttempts, 100n, 1n);
      counter(limits.waitSliceMs, 25000n, 1n);
      const expected = await http.processing.admitPreparation(preparation);
      if (!expected.ok) throw new CoordinationInputError(expected.failure.message);
      if (!expected.value.ok) throw new CoordinationInputError(expected.value.message);
      const result = await http.request({
        path: "/reservation-waits/prepare",
        method: "POST",
        codec: waitJob,
        responseBudget: "operation",
        body: d.jsonObject([
          ["preparation", preparationJson(expected.value.preparation)],
          ["timeout_ms", d.jsonString(limits.timeoutMs)],
          ["max_attempts", d.jsonString(limits.maxAttempts)],
          ["wait_slice_ms", d.jsonString(limits.waitSliceMs)],
        ]),
      });
      if (!result.ok) return result;
      const s = result.data.preparation,
        actual = await http.processing.admitPreparation({
          intention_id: s.intention_id,
          connection_id: s.connection.id,
          generation: s.connection.generation,
          context: s.context,
          method: s.method,
          params: s.params,
        });
      if (!actual.ok) throw new CoordinationInputError(actual.failure.message);
      if (
        !actual.value.ok ||
        actual.value.identity !== expected.value.identity ||
        s.connection.id !== expectedConnection.id ||
        s.connection.generation !== expectedConnection.generation ||
        s.connection.socket !== expectedConnection.socket ||
        s.connection.label !== expectedConnection.label ||
        result.data.limits.timeoutMs !== limits.timeoutMs ||
        result.data.limits.maxAttempts !== limits.maxAttempts ||
        result.data.limits.waitSliceMs !== limits.waitSliceMs
      )
        return invalid(
          "Saved reservation wait changed its immutable preparation or explicit bounds.",
        );
      return result;
    },
    act: (id: Identifier, action: "start" | "cancel" | "retry-exact") =>
      http.request({
        path: `/reservation-waits/${encodeURIComponent(id)}/${action}`,
        method: "POST",
        codec: waitJob,
        responseBudget: "operation",
        body: d.jsonObject([]),
      }),
  };
}
