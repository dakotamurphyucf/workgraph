import type { FeatureContext } from "../../../app/types";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Identifier,
  ReadResponse,
} from "../../../core/protocol/types";
import type { ReadState } from "../../../core/state/read-slot";
import type { Comment } from "../threads/types";
/** Comment revision and current planning capture remain different namespaces. */
export interface CommentSelection {
  readonly connectionId: Identifier;
  readonly generation: Decimal;
  readonly workspaceId: Identifier;
  readonly commentId: Identifier;
  readonly revision: Decimal;
}
export interface CommentCapture {
  readonly selection: CommentSelection;
  readonly connection: ConnectionProfile;
  readonly comment: Comment;
  readonly planningRevision: Decimal;
  readonly partial: boolean;
  readonly response: ReadResponse;
}
export interface CommentController {
  readonly get: () => ReadState<CommentCapture>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly select: (selection: CommentSelection) => Promise<void>;
  readonly cancel: () => void;
  readonly dispose: () => void;
}
export interface CommentOptions {
  readonly http: HttpClient;
}
export interface CommentFeatureProps {
  readonly context: FeatureContext;
  readonly controller: CommentController;
}
export type CommentReader = (
  selection: CommentSelection,
  signal: AbortSignal,
) => Promise<HttpResult<CommentCapture>>;
