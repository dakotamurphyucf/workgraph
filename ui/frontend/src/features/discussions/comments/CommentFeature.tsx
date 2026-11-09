import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Badge, Button, Panel } from "../../../components/Primitives";
import { ContentViewer, type ContentSource } from "../../../content";
import { commentSelection } from "./model";
import { failureText } from "../../connections/failure";
import { JsonView, LazyDetails } from "../../connections/shared";
import { planningRoute } from "../../history/scope-navigation/model";
import { resourceRoute } from "../../knowledge/resources/navigation";
import { commentKey } from "./controller";
import type { CommentCapture, CommentFeatureProps } from "./types";
function Record({
  capture,
  context,
}: {
  readonly capture: CommentCapture;
  readonly context: CommentFeatureProps["context"];
}) {
  const { comment, selection } = capture;
  const source = useMemo<ContentSource>(
    () => ({
      key: commentKey(selection),
      label: `Comment ${comment.id} · revision ${comment.revision}`,
      bytes: new TextEncoder().encode(comment.body),
      completeness: capture.partial ? "partial" : "complete",
      hints: { mime: "text/markdown", intent: "prose" },
    }),
    [capture.partial, comment, selection],
  );
  const target = comment.target;
  const route =
    target.kind === "resource"
      ? resourceRoute({
          connectionId: selection.connectionId,
          generation: selection.generation,
          workspaceId: selection.workspaceId,
          resourceId: target.id,
          content: null,
        })
      : planningRoute({
          connectionId: selection.connectionId,
          generation: selection.generation,
          workspaceId: selection.workspaceId,
          kind: target.kind,
          id: target.kind === "workspace" ? selection.workspaceId : target.id,
        });
  return (
    <Panel
      title={`Comment ${comment.id}`}
      actions={<Badge>Pinned revision {comment.revision}</Badge>}
    >
      <p>
        By {comment.authorId} · {comment.timestamp} · {comment.kind}
      </p>
      {selection.generation !== context.connection.generation && (
        <p role="status">
          Recorded endpoint generation {selection.generation}; the profile currently selects{" "}
          {context.connection.generation}. No replacement endpoint was used.
        </p>
      )}
      {capture.partial && (
        <p role="status">
          This response is partial or its coverage is unknown. Retained source metadata remains
          available.
        </p>
      )}
      {comment.tombstone ? (
        <p>This revision records a deletion. Its text is empty.</p>
      ) : (
        <ContentViewer source={source} />
      )}
      <Button onClick={() => context.navigate(route)}>
        Open {target.kind} target · current resolution
      </Button>
      <LazyDetails summary="Exact comment source and capture">
        <p>
          Generation {selection.generation} · comment revision {selection.revision} · planning
          capture {capture.planningRevision}
        </p>
        <JsonView
          value={comment.raw}
          label="Exact comment record"
          processing={context.client.processing}
          identity={commentKey(selection)}
        />
      </LazyDetails>
    </Panel>
  );
}
export function CommentFeature({ context, controller }: CommentFeatureProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get),
    selection = useMemo(() => commentSelection(context.route), [context.route]),
    key = selection === null ? null : commentKey(selection);
  useEffect(() => {
    if (selection !== null) void controller.select(selection);
    else controller.cancel();
    return () => controller.cancel();
  }, [controller, selection]);
  if (selection === null)
    return <p role="alert">This link has no valid pinned comment identity.</p>;
  if (state.kind === "idle" || state.key !== key)
    return <p role="status">Opening exact comment revision…</p>;
  if (state.kind === "unexpected_error") throw state.error;
  if (state.kind === "loading") return <p role="status">Reading pinned comment revision…</p>;
  if (state.kind === "failed") return <p role="alert">{failureText(state.failure)}</p>;
  return <Record capture={state.value} context={context} />;
}
