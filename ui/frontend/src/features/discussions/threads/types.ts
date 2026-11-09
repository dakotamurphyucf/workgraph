import type { LiveReadable } from "../../../core/state/live-types";
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
import type { TicketDiscussionTarget } from "../../work/progress";

export type DiscussionScope =
  { readonly kind: "workspace" } | { readonly kind: "project"; readonly id: Identifier };
export type DiscussionLink =
  | { readonly kind: "workspace" }
  | {
      readonly kind: "project" | "milestone" | "ticket" | "resource";
      readonly id: Identifier;
    };
export type Recipient = { readonly kind: "actor" | "run"; readonly id: Identifier };
export type ThreadStatus = "open" | "awaiting_response" | "resolved";
export type ClosurePolicy = "manual" | "when_all_requests_terminal";
export interface Endpoint {
  readonly connectionId: Identifier;
  readonly generation: Decimal;
  readonly workspaceId: Identifier;
}
/** All targets are exact local associations. Selecting never acknowledges a
 * delivery or accepts, cancels or resolves an accountable request. */
export type DiscussionTarget =
  | (Endpoint & { readonly kind: "board"; readonly boardId: Identifier })
  | (Endpoint & { readonly kind: "thread"; readonly threadId: Identifier })
  | TicketDiscussionTarget
  | (Endpoint & {
      readonly kind: "direct_messages";
      readonly capture: {
        readonly consumerId: Identifier;
        readonly recipient: Recipient;
        readonly after: Decimal;
        readonly through: Decimal;
        readonly ticketId: Identifier | null;
        readonly excludeSelf: boolean;
        readonly notificationId: Decimal | null;
      } | null;
    });
export interface Board {
  readonly id: Identifier;
  readonly revision: Decimal;
  readonly title: string;
  readonly scope: DiscussionScope;
  readonly raw: JsonObject;
}
export interface Comment {
  readonly id: Identifier;
  readonly target: DiscussionLink;
  readonly authorId: Identifier;
  readonly createdAt: string;
  readonly replyToId: Identifier | null;
  readonly kind: "comment" | "progress" | "decision" | "blocker" | "evidence";
  readonly origin: "authored" | "completion";
  readonly revision: Decimal;
  readonly serial: Decimal;
  readonly sequence: Decimal;
  readonly actorId: Identifier;
  readonly timestamp: string;
  readonly body: string;
  readonly tombstone: boolean;
  readonly raw: JsonObject;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly offset: Decimal;
  readonly remaining: Decimal;
  readonly nextOffset: Decimal | null;
}
export interface RelatedMessages {
  readonly threadId: Identifier;
  readonly threadRevision: Decimal;
  readonly discussionSerial: Decimal;
  /** Attachment order; current comment versions, including tombstones. This is
   * not chronological order and not the original immutable request/DM body. */
  readonly messages: Page<Comment>;
}
export interface Thread {
  readonly id: Identifier;
  readonly revision: Decimal;
  readonly boardId: Identifier;
  readonly title: string;
  readonly participants: readonly Identifier[];
  readonly mentions: readonly Identifier[];
  readonly links: readonly DiscussionLink[];
  readonly status: ThreadStatus;
  readonly closurePolicy: ClosurePolicy;
  readonly pinned: boolean;
  readonly commentIds: readonly Identifier[];
  readonly pinnedCommentIds: readonly Identifier[];
  readonly related: RelatedMessages | undefined;
  readonly raw: JsonObject;
}
export interface MessageBody {
  readonly commentId: Identifier;
  readonly revision: Decimal;
  readonly serial: Decimal;
  readonly actorId: Identifier;
  readonly timestamp: string;
  readonly body: string;
  readonly tombstone: boolean;
  readonly versionKind: "captured";
  readonly raw: JsonObject;
}
export interface DirectMessage {
  readonly notificationId: Decimal;
  readonly sequence: Decimal;
  readonly messageId: Identifier;
  readonly sourceRevision: Decimal;
  readonly sourceCurrentRevision: Decimal;
  readonly ticketIds: readonly Identifier[];
  readonly actorId: Identifier;
  readonly runId: Identifier | null;
  readonly timestamp: string;
  readonly body: MessageBody | null;
  readonly causalBody: { readonly commentId: Identifier; readonly revision: Decimal } | null;
  readonly raw: JsonObject;
}
export interface MessagePage {
  readonly consumerId: Identifier;
  readonly recipient: Recipient;
  readonly after: Decimal;
  readonly through: Decimal;
  readonly nextAfter: Decimal;
  readonly remaining: Decimal;
  /** Notifications in activity order, as captured by the daemon. Only unread
   * entries for this explicit consumer/recipient are returned. */
  readonly items: readonly DirectMessage[];
}
export interface Captured<T> {
  readonly endpoint: Endpoint;
  readonly invocation: ReadInvocation;
  readonly response: ReadResponse;
  readonly value: T;
}
export interface ThreadFilter {
  readonly scope: DiscussionScope | null;
  readonly boardId: string;
  readonly actorId: string;
  readonly status: ThreadStatus | "all";
  readonly unresolved: boolean;
  readonly text: string;
  readonly pageSize: "1" | "25";
}
export interface MessageFilter {
  /** Independent of the acting writer. Changing recipient never adopts it as
   * author, acknowledges entries or changes consumer state. */
  readonly recipient: { readonly kind: "actor" | "run"; readonly id: string };
  /** Dedicated read-only browser consumer, separate from actionable Inbox.
   * This feature never acknowledges it. Native reads still filter any IDs
   * acknowledged externally, even when after=0; this is not a sent archive. */
  readonly consumerId: string;
  readonly after: string;
  /** Empty for a new query; exact notification upper bound for a retained link. */
  readonly through: string;
  readonly ticketId: string;
  readonly excludeSelf: boolean;
}
export type ThreadsRead =
  | { readonly kind: "boards"; readonly scope: DiscussionScope | null }
  | { readonly kind: "board"; readonly boardId: Identifier }
  | { readonly kind: "threads"; readonly filter: ThreadFilter }
  | { readonly kind: "thread" | "thread_history"; readonly threadId: Identifier }
  | { readonly kind: "ticket_comments"; readonly ticketId: Identifier }
  | {
      readonly kind: "comment_history";
      readonly commentId: Identifier;
      readonly target: DiscussionLink;
      readonly selectedRevision: Decimal | null;
    }
  | { readonly kind: "messages"; readonly filter: MessageFilter };
export type ThreadsValue =
  | { readonly kind: "boards"; readonly page: Page<Board> }
  | { readonly kind: "board"; readonly board: Board }
  | { readonly kind: "threads" | "thread_history"; readonly page: Page<Thread> }
  | { readonly kind: "thread"; readonly thread: Thread }
  | { readonly kind: "ticket_comments" | "comment_history"; readonly page: Page<Comment> }
  | { readonly kind: "messages"; readonly page: MessagePage };
export interface ReadCapture {
  readonly selector: ThreadsRead;
  readonly captured: Captured<ThreadsValue>;
}
export interface BoardFields {
  readonly id: string;
  readonly title: string;
  readonly scope:
    { readonly kind: "workspace" } | { readonly kind: "project"; readonly id: string };
}
export interface ThreadFields {
  readonly id: string;
  readonly boardId: string;
  readonly title: string;
  readonly participants: string;
  readonly mentions: string;
  readonly links: readonly { readonly kind: DiscussionLink["kind"]; readonly id: string }[];
  readonly status: ThreadStatus;
  readonly closurePolicy: ClosurePolicy;
  readonly pinned: boolean;
}
export type ThreadsInput =
  | { readonly method: "board.put"; readonly fields: BoardFields; readonly existing: boolean }
  | { readonly method: "thread.put"; readonly fields: ThreadFields; readonly existing: boolean }
  | {
      readonly method: "thread.reply";
      readonly threadId: string;
      readonly body: string;
      readonly kind: Comment["kind"];
      readonly replyToId: string;
    }
  | { readonly method: "thread.attach"; readonly threadId: string; readonly commentId: string }
  | {
      readonly method: "thread.pin_message";
      readonly threadId: string;
      readonly commentId: string;
      readonly pinned: boolean;
    }
  | {
      readonly method: "comment.add";
      readonly target: DiscussionLink;
      readonly body: string;
      readonly kind: Comment["kind"];
      readonly replyToId: string;
    }
  | { readonly method: "comment.edit"; readonly commentId: string; readonly body: string }
  | { readonly method: "comment.tombstone"; readonly commentId: string }
  | {
      readonly method: "message.send";
      readonly messageId: string;
      readonly body: string;
      readonly actorRecipients: string;
      readonly runRecipients: string;
      readonly teamIds: string;
      readonly ticketId: string;
      readonly replyToMessageId: string;
      readonly correlationId: string;
    };
export interface DraftGuards {
  readonly board: Captured<Board> | undefined;
  readonly thread: Captured<Thread> | undefined;
  readonly comment: Captured<Comment> | undefined;
}
export interface ThreadsDraft {
  readonly id: Identifier;
  readonly context: FeatureContext;
  readonly endpoint: Endpoint;
  readonly input: ThreadsInput;
  readonly guards: DraftGuards;
  readonly editRevision: number;
  readonly phase:
    | { readonly kind: "editing" }
    | { readonly kind: "loading" | "capturing" }
    | { readonly kind: "captured"; readonly preparation: Preparation };
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
  /** One explicit Post attempt has requested execution. A lost reply never
   * resets this to unsent or enables a fresh identity. */
  readonly posted: boolean;
}
export interface ThreadsState {
  readonly endpoint: Endpoint | null;
  readonly historicalGeneration: boolean;
  readonly target: DiscussionTarget | null;
  readonly unavailable: string | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
  readonly filter: ThreadFilter;
  readonly messageFilter: MessageFilter;
  readonly reads: ReadonlyMap<ThreadsRead["kind"], ReadState<ReadCapture>>;
  readonly selectors: ReadonlyMap<ThreadsRead["kind"], ThreadsRead>;
  readonly drafts: readonly ThreadsDraft[];
  readonly selectedDraftId: Identifier | null;
}
export interface ThreadsOptions {
  readonly http: HttpClient;
  readonly operations: OperationController;
}
export interface ThreadsController extends LiveReadable {
  readonly get: () => ThreadsState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly open: (context: FeatureContext, target?: DiscussionTarget) => void;
  readonly filter: (value: ThreadFilter) => void;
  readonly messageFilter: (value: MessageFilter) => void;
  /** New load captures a new native revision; next/retry repeat only the saved
   * exact native request and reject selector/scope changes. */
  readonly read: (selector: ThreadsRead, page?: "next" | "retry" | "repeat") => Promise<void>;
  readonly create: (input: ThreadsInput) => Identifier | null;
  readonly select: (id: Identifier | null) => void;
  readonly edit: (id: Identifier, input: ThreadsInput) => void;
  readonly loadGuards: (id: Identifier) => Promise<void>;
  /** Explicitly copy complete loaded metadata/body into the existing editor.
   * Late reads never prefill or overwrite authored text automatically. */
  readonly fill: (id: Identifier) => void;
  readonly review: (id: Identifier) => Promise<void>;
  /** Simple new reply/comment/direct message: prepare then execute once.
   * Metadata edits and destructive actions use Review then Apply. */
  readonly post: (id: Identifier) => Promise<void>;
  readonly close: (id: Identifier) => void;
  readonly dispose: () => void;
}
export interface ThreadsFeatureProps {
  readonly context: FeatureContext;
  readonly controller: ThreadsController;
  readonly operations: OperationController;
  readonly target?: DiscussionTarget;
  /** Later accountable requests/inbox children compose their actual controls;
   * reading this surface never performs their mutations. */
  readonly renderRequests?: (scope: Endpoint, thread: Captured<Thread> | null) => ReactNode;
  readonly renderInbox?: (scope: Endpoint) => ReactNode;
}
