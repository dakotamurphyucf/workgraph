import type { LiveReadable } from "../../../core/state/live-types";
import type { RequestWaitController } from "./wait/types";
import type { ReactNode } from "react";
import type { FeatureContext } from "../../../app/types";
import type { HttpClient } from "../../../core/protocol/http";
import type {
  Decimal,
  Identifier,
  JsonObject,
  Preparation,
  ReadInvocation,
  ReadResponse,
} from "../../../core/protocol/types";
import type { OperationController } from "../../../core/state/operations";
import type { ReadState } from "../../../core/state/read-slot";
import type {
  Captured,
  Comment,
  DiscussionLink,
  DiscussionScope,
  Endpoint,
  Page,
  Recipient,
  RelatedMessages,
  Thread,
  ThreadsFeatureProps,
} from "../threads/types";

export type RequestKind = "clarification" | "review" | "help" | "blocker_resolution" | "handoff";
export type NotificationKind =
  | "thread_changed"
  | "message_received"
  | "request_created"
  | "request_acknowledged"
  | "request_accepted"
  | "request_reassigned"
  | "request_resolved"
  | "request_cancelled"
  | "request_updated";
export interface Attribution {
  readonly actorId: Identifier;
  readonly runId: Identifier | null;
  readonly timestamp: string;
}
export interface CommentPin {
  readonly id: Identifier;
  readonly revision: Decimal;
}
export type RequestStatus =
  | { readonly kind: "open" }
  | {
      readonly kind: "resolved";
      readonly attribution: Attribution;
      readonly answer: CommentPin | null;
    }
  | { readonly kind: "cancelled"; readonly attribution: Attribution };
export type Responsibility =
  | { readonly kind: "unaccepted" }
  | { readonly kind: "accepted"; readonly recipient: Recipient; readonly attribution: Attribution };
export interface Delivery {
  readonly recipient: Recipient;
  readonly acknowledged: Attribution | null;
}
/** An immutable entity snapshot. Its revision is never a communication query
 * capture, and later team/subscription configuration never changes deliveries. */
export interface RequestRecord {
  readonly id: Identifier;
  readonly revision: Decimal;
  readonly threadId: Identifier;
  readonly kind: RequestKind;
  readonly question: CommentPin;
  readonly correlationId: string | null;
  readonly replyToId: Identifier | null;
  /** Exact signed-int64 Unix milliseconds; no automatic expiry is implied. */
  readonly deadlineUnixMs: string | null;
  readonly priority: Decimal;
  readonly relatedIds: readonly Identifier[];
  readonly supersedesIds: readonly Identifier[];
  readonly resolverId: Identifier;
  readonly created: Attribution;
  readonly deliveries: readonly Delivery[];
  readonly responsibility: Responsibility;
  readonly status: RequestStatus;
  readonly raw: JsonObject;
}
export interface ThreadSummary {
  readonly revision: Decimal;
  readonly title: string;
  readonly titleBytes: Decimal;
  readonly scope: DiscussionScope;
  readonly links: readonly DiscussionLink[];
  readonly linkCount: Decimal;
}
export interface ListedRequest extends RequestRecord {
  /** Current thread projection from the list capture, not historical metadata. */
  readonly threadSummary: ThreadSummary;
}
export interface CurrentRequest extends RequestRecord {
  readonly threadRevision: Decimal;
  readonly questionBody: Comment;
  readonly answerBody: Comment | null;
  readonly supersededByIds: readonly Identifier[];
  readonly related:
    | (RelatedMessages & { readonly requestRevision: Decimal; readonly currentQuestion: Comment })
    | null;
}
export interface Team {
  readonly id: Identifier;
  readonly revision: Decimal;
  readonly title: string;
  readonly members: readonly Recipient[];
  readonly raw: JsonObject;
}
export interface SubscriptionFilter {
  readonly scope: DiscussionScope | null;
  readonly threadId: Identifier | null;
  readonly kinds: readonly NotificationKind[];
}
export interface Subscription {
  readonly id: Identifier;
  readonly revision: Decimal;
  readonly recipient: Recipient;
  readonly filter: SubscriptionFilter;
  readonly active: boolean;
  readonly raw: JsonObject;
}
export interface Notification {
  readonly id: Decimal;
  readonly sequence: Decimal;
  readonly kind: NotificationKind;
  readonly scope: DiscussionScope;
  readonly source: { readonly kind: "thread" | "message" | "request"; readonly id: Identifier };
  readonly sourceRevision: Decimal;
  readonly currentSourceRevision: Decimal | null;
  readonly causalBody: CommentPin | null;
  readonly capturedBody:
    | (CommentPin & {
        readonly body: string;
        readonly serial: Decimal;
        readonly actorId: Identifier;
        readonly timestamp: string;
        readonly tombstone: boolean;
      })
    | null;
  readonly attribution: Attribution;
  /** A labelled current observation, not an acknowledgement or causal snapshot. */
  readonly currentRequestStatus: "open" | "resolved" | "cancelled" | null;
  readonly ticketIds: readonly Identifier[];
  readonly raw: JsonObject;
}
export interface InboxPage {
  readonly consumerId: Identifier;
  readonly recipient: Recipient;
  readonly after: Decimal;
  readonly through: Decimal;
  readonly nextAfter: Decimal;
  readonly remaining: Decimal;
  readonly excludeSelf: boolean;
  readonly items: readonly Notification[];
  readonly raw: JsonObject;
}
export interface EditableRecipient {
  readonly kind: "actor" | "run";
  readonly id: string;
}
export interface RequestFilter {
  readonly scope:
    { readonly kind: "workspace" } | { readonly kind: "project"; readonly id: string } | null;
  readonly threadId: string;
  readonly ticketId: string;
  readonly resolverId: string;
  readonly recipient: EditableRecipient | null;
  readonly responsible: EditableRecipient | null;
  readonly kind: RequestKind | "all";
  readonly priority: string;
  readonly openOnly: boolean;
  readonly unanswered: boolean;
  readonly overdueAtUnixMs: string;
  readonly relatedToId: string;
  readonly supersedesId: string;
  readonly supersededById: string;
}
export interface InboxFilter {
  /** Explicit actionable consumer. ui-received-* consumers are read-only. */
  readonly consumerId: string;
  readonly recipient: EditableRecipient;
  readonly after: string;
  readonly through: string;
  readonly kinds: readonly NotificationKind[];
  readonly ticketId: string;
  readonly excludeSelf: boolean;
}
export type RequestsTarget =
  | (Endpoint & { readonly kind: "requests" })
  | (Endpoint & {
      readonly kind: "request";
      readonly requestId: Identifier;
      readonly revision: Decimal | null;
    })
  | (Endpoint & {
      readonly kind: "inbox";
      readonly capture: (InboxFilter & { readonly notificationId: Decimal | null }) | null;
    })
  | (Endpoint & {
      readonly kind: "routing";
      readonly entity: { readonly kind: "team" | "subscription"; readonly id: Identifier } | null;
    })
  | (Endpoint & { readonly kind: "thread_requests"; readonly threadId: Identifier });
export type RequestsRead =
  | { readonly kind: "requests"; readonly filter: RequestFilter }
  | { readonly kind: "request"; readonly requestId: Identifier }
  | {
      readonly kind: "history";
      readonly requestId: Identifier;
      readonly selectedRevision: Decimal | null;
    }
  | { readonly kind: "historical_comment"; readonly pin: CommentPin }
  | { readonly kind: "inbox"; readonly filter: InboxFilter; readonly wait: boolean }
  | { readonly kind: "teams" }
  | { readonly kind: "team"; readonly teamId: Identifier }
  | { readonly kind: "subscriptions"; readonly recipient: EditableRecipient | null }
  | { readonly kind: "subscription"; readonly subscriptionId: Identifier };
export type RequestsValue =
  | { readonly kind: "requests"; readonly page: Page<ListedRequest> }
  | { readonly kind: "request"; readonly request: CurrentRequest }
  | { readonly kind: "history"; readonly page: Page<RequestRecord> }
  | { readonly kind: "historical_comment"; readonly page: Page<Comment> }
  | { readonly kind: "inbox"; readonly page: InboxPage }
  | { readonly kind: "teams"; readonly page: Page<Team> }
  | { readonly kind: "team"; readonly team: Team }
  | { readonly kind: "subscriptions"; readonly page: Page<Subscription> }
  | { readonly kind: "subscription"; readonly subscription: Subscription };
export interface ReadCapture {
  readonly selector: RequestsRead;
  readonly captured: Captured<RequestsValue>;
}
export type Change<T> = { readonly kind: "keep" } | { readonly kind: "value"; readonly value: T };
export type NullableChange<T> = Change<T> | { readonly kind: "clear" };
export interface RequestFields {
  readonly id: string;
  readonly kind: RequestKind;
  readonly recipients: readonly EditableRecipient[];
  readonly resolverId: string;
  readonly priority: string;
  readonly deadlineUnixMs: string;
  readonly relatedIds: readonly string[];
  readonly supersedesIds: readonly string[];
}
export type RequestsInput =
  | {
      readonly method: "request.ask";
      readonly fields: RequestFields;
      readonly body: string;
      readonly destination:
        | {
            readonly kind: "new";
            readonly title: string;
            readonly boardId: string;
            readonly ticketId: string;
          }
        | { readonly kind: "thread"; readonly threadId: string };
    }
  | {
      readonly method: "request.create";
      readonly fields: RequestFields;
      readonly threadId: string;
      readonly commentId: string;
      readonly teams: readonly string[];
      readonly correlationId: string;
      readonly replyToId: string;
    }
  | {
      readonly method: "request.acknowledge" | "request.accept";
      readonly requestId: string;
      readonly recipient: EditableRecipient;
    }
  | {
      readonly method: "request.reassign";
      readonly requestId: string;
      readonly recipient: EditableRecipient | null;
    }
  | { readonly method: "request.resolve"; readonly requestId: string; readonly body: string }
  | { readonly method: "request.cancel"; readonly requestId: string }
  | {
      readonly method: "request.metadata";
      readonly requestId: string;
      readonly priority: Change<string>;
      readonly deadlineUnixMs: NullableChange<string>;
      readonly relatedIds: Change<readonly string[]>;
      readonly supersedesIds: Change<readonly string[]>;
    }
  | {
      readonly method: "inbox.ack";
      readonly consumerId: string;
      readonly recipient: EditableRecipient;
      readonly notificationIds: readonly Decimal[];
    }
  | {
      readonly method: "team.put";
      readonly existing: boolean;
      readonly teamId: string;
      readonly title: string;
      readonly members: readonly EditableRecipient[];
    }
  | {
      readonly method: "subscription.put";
      readonly existing: boolean;
      readonly subscriptionId: string;
      readonly recipient: EditableRecipient;
      readonly filter: {
        readonly scope:
          { readonly kind: "workspace" } | { readonly kind: "project"; readonly id: string } | null;
        readonly threadId: string;
        readonly kinds: readonly NotificationKind[];
      };
      readonly active: boolean;
    };
export interface DraftGuards {
  readonly request: Captured<CurrentRequest> | undefined;
  readonly thread: Captured<Thread> | undefined;
  readonly comment: Captured<Comment> | undefined;
  readonly team: Captured<Team> | undefined;
  readonly subscription: Captured<Subscription> | undefined;
  readonly inbox: Captured<InboxPage> | undefined;
}
export interface RequestsDraft {
  readonly id: Identifier;
  readonly context: FeatureContext;
  readonly endpoint: Endpoint;
  readonly input: RequestsInput;
  readonly guards: DraftGuards;
  readonly editRevision: number;
  readonly phase:
    | { readonly kind: "editing" | "loading" | "capturing" }
    | { readonly kind: "captured"; readonly preparation: Preparation };
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface RequestsState {
  readonly endpoint: Endpoint | null;
  readonly target: RequestsTarget | null;
  readonly historicalGeneration: boolean;
  readonly unavailable: string | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
  readonly filter: RequestFilter;
  readonly inboxFilter: InboxFilter;
  readonly reads: ReadonlyMap<RequestsRead["kind"], ReadState<ReadCapture>>;
  readonly selectors: ReadonlyMap<RequestsRead["kind"], RequestsRead>;
  readonly drafts: readonly RequestsDraft[];
  readonly selectedDraftId: Identifier | null;
}
export interface RequestsOptions {
  readonly http: HttpClient;
  readonly operations: OperationController;
}
export interface RequestsController extends LiveReadable {
  readonly waiter: RequestWaitController;
  readonly get: () => RequestsState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Entering a newly mounted view resets an unpinned Inbox to the UI actor.
   * Ordinary context updates preserve the reader's manual recipient selection. */
  readonly open: (
    context: FeatureContext,
    target?: RequestsTarget | null,
    entering?: boolean,
  ) => void;
  readonly filter: (value: RequestFilter) => void;
  readonly inboxFilter: (value: InboxFilter) => void;
  readonly read: (selector: RequestsRead, page?: "next" | "retry" | "repeat") => Promise<void>;
  readonly create: (input: RequestsInput, inbox?: Captured<InboxPage>) => Identifier | null;
  readonly select: (id: Identifier | null) => void;
  readonly edit: (id: Identifier, input: RequestsInput) => void;
  readonly loadGuards: (id: Identifier) => Promise<void>;
  readonly fill: (id: Identifier) => void;
  readonly review: (id: Identifier) => Promise<void>;
  readonly close: (id: Identifier) => void;
  readonly dispose: () => void;
}
export interface RequestsFeatureProps {
  readonly context: FeatureContext;
  readonly controller: RequestsController;
  readonly operations: OperationController;
  readonly target?: RequestsTarget | null;
  readonly renderDiscussions: (
    slots: Pick<ThreadsFeatureProps, "renderRequests" | "renderInbox">,
  ) => ReactNode;
  /** The host uses the accepted Threads composer, preserving its own retained
   * target and shared intention lifetime. Replying never resolves a request. */
  readonly onReply: (target: Endpoint & { readonly threadId: Identifier }) => void;
}
export interface NativeRead {
  readonly invocation: ReadInvocation;
  readonly response: ReadResponse;
}
