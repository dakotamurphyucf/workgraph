import type { HttpFailure, HttpClient } from "../../../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Identifier,
  JsonObject,
} from "../../../../core/protocol/types";
import type { Endpoint } from "../../threads/types";
import type { CurrentRequest } from "../types";

/** Actual request.get is current-only. Historical snapshot readers must explicitly open current. */
export interface RequestWaitPlan extends Endpoint {
  readonly requestId: Identifier;
  readonly timeoutMs: Decimal;
  readonly pollIntervalMs: Decimal;
}
export type RequestWaitStop = "resolved" | "cancelled" | "deadline" | "incomplete";
export interface RequestWaitObservation {
  readonly plan: RequestWaitPlan;
  readonly profile: ConnectionProfile;
  readonly request: CurrentRequest;
  readonly stop: RequestWaitStop;
  readonly resolved: boolean;
  /** Native Json.int is an exact canonical decimal string, bounded by this invocation. */
  readonly pollCount: Decimal;
  readonly metadata: JsonObject;
  readonly raw: JsonObject;
}
export type RequestWaitState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "waiting";
      readonly plan: RequestWaitPlan;
      readonly last: RequestWaitObservation | null;
    }
  | {
      readonly kind: "stopped";
      readonly plan: RequestWaitPlan;
      readonly observation: RequestWaitObservation;
    }
  | {
      readonly kind: "cancelled_locally";
      readonly plan: RequestWaitPlan;
      readonly last: RequestWaitObservation | null;
    }
  | {
      readonly kind: "failed";
      readonly plan: RequestWaitPlan;
      readonly last: RequestWaitObservation | null;
      readonly failure: HttpFailure;
    }
  | {
      readonly kind: "unexpected_error";
      readonly plan: RequestWaitPlan;
      readonly last: RequestWaitObservation | null;
      readonly error: unknown;
    };
export interface RequestWaitController {
  readonly get: () => RequestWaitState;
  readonly subscribe: (listener: () => void) => () => void;
  /** One explicit start only; same active plan coalesces. Never a mount effect or auto retry. */
  readonly start: (plan: RequestWaitPlan) => Promise<void>;
  readonly stop: () => void;
  /** Navigation fencing cancels an obsolete foreground read, never retargets its captured plan. */
  readonly select: (target: (Endpoint & { readonly requestId: Identifier }) | null) => void;
  readonly dispose: () => void;
}
export interface RequestWaitOptions {
  readonly http: HttpClient;
}
