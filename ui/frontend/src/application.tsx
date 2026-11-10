import { createLiveReadOwner } from "./core/state/live-owner";
import { createLiveChangeReader } from "./core/state/live-client";
import type { LiveReadOwner } from "./core/state/live-types";
import { askAboutTicket } from "./features/work/actions/ask-ticket";
import { LiveReads } from "./app/LiveReads";
import {
  createCustomController,
  CustomValuePresentation,
  CustomViewsFeature,
  type CustomController,
} from "./features/custom/editor";
import {
  createSearchController,
  SearchFeature,
  FactDestination,
  type SearchController,
} from "./features/search";
import {
  createCommentController,
  CommentFeature,
  type CommentController,
} from "./features/discussions/comments";
import {
  createOverviewController,
  OverviewFeature,
  ActivityFeature,
  type OverviewController,
} from "./features/overview";
import {
  PlanningTargetFeature,
  canOpenPlanningScope,
  planningTarget,
  planningRoute,
  planningTargetFromRoute,
} from "./features/history/scope-navigation";
import type { ReactNode } from "react";
import { WorkbenchDestination } from "./features/work/WorkbenchDestination";
import { App } from "./app/App";
import type { ConnectionsRenderContext, FeatureContext } from "./app/types";
import { StatePanel } from "./components/Primitives";
import {
  AdvancedFeature,
  createAdvancedController,
  type AdvancedController,
} from "./features/advanced";
import {
  ConnectionManager,
  ConnectionLifecycleFeature,
  createConnectionDraftStore,
  type ConnectionDraftStore,
} from "./features/connections";
import { createCompanion, type Companion } from "./core/protocol/client";
import type { HttpClient } from "./core/protocol/http";
import { createOperationController, type OperationController } from "./core/state/operations";
import {
  AdministrationFeature,
  createAdministrationController,
  type AdministrationController,
} from "./features/administration";
import { createWorkController, type WorkController } from "./features/work/views";
import {
  createWorkActionsController,
  WorkActionsFeature,
  type WorkActionsController,
} from "./features/work/actions";
import {
  HistoryFeature,
  createHistoryController,
  type HistoryController,
} from "./features/history/transcript";
import {
  createWorkProgressController,
  WorkProgressFeature,
  type ProgressController,
} from "./features/work/progress";
import { createGraphController, type GraphController } from "./features/workflow/graph";
import { WorkflowFeature } from "./features/workflow/WorkflowFeature";
import { createPlansController, type PlansController } from "./features/workflow/plans";
import {
  EvidenceFeature,
  createEvidenceController,
  type EvidenceController,
} from "./features/workflow/evidence";
import {
  ThreadsFeature,
  createThreadsController,
  discussionRoute,
  type ThreadsController,
} from "./features/discussions/threads";
import {
  ParticipantsFeature,
  createParticipantsController,
  canOpenHistoryRun,
  historyRunRoute,
  type ParticipantsController,
} from "./features/participants/runs";
import {
  RequestsFeature,
  createRequestsController,
  type RequestsController,
} from "./features/discussions/requests";
import {
  ParticipantsWorkspace,
  createCoordinationController,
  type CoordinationController,
} from "./features/participants/coordination";
import {
  createHistoryAnalyticsController,
  HistoryAnalyticsFeature,
  type HistoryAnalyticsController,
} from "./features/history/analytics";
import {
  ResourcesFeature,
  createResourceUploadController,
  type ResourceUploadController,
  createResourcesController,
  createResourceDraftController,
  canOpenResource,
  resourceRoute,
  type ResourceDraftController,
  type ResourcesController,
} from "./features/knowledge/resources";
import {
  FactsFeature,
  createFactsController,
  type FactsController,
  type FactSelection,
} from "./features/knowledge/facts";
import {
  createRichViewerController,
  ResourceViewer,
  type RichViewerController,
} from "./features/knowledge/viewers";
import {
  createLocalEvidenceController,
  type LocalEvidenceController,
} from "./features/workflow/local-evidence";
import type { TicketEvidenceTarget } from "./features/work/progress/types";
/** One launch owns controllers and unsent drafts across navigation and scope remounts. */
// Page refinements follow feature base sheets so both participant subtrees share one palette.
import "./features/participants/participants-continuity.css";
import "./features/history/transcript/history-continuity.css";

export interface ApplicationServices {
  readonly custom: CustomController;
  readonly http: HttpClient;
  readonly liveReads: LiveReadOwner;
  readonly companion: Companion;
  readonly operations: OperationController;
  readonly advanced: AdvancedController;
  readonly connections: ConnectionDraftStore;
  readonly work: WorkController;
  readonly graph: GraphController;
  readonly plans: PlansController;
  readonly evidence: EvidenceController;
  readonly workActions: WorkActionsController;
  readonly workProgress: ProgressController;
  readonly administration: AdministrationController;
  readonly history: HistoryController;
  readonly historyAnalytics: HistoryAnalyticsController;
  readonly threads: ThreadsController;
  readonly requests: RequestsController;
  readonly participants: ParticipantsController;
  readonly coordination: CoordinationController;
  readonly resources: ResourcesController;
  readonly resourceDrafts: ResourceDraftController;
  readonly resourceUploads: ResourceUploadController;
  readonly facts: FactsController;
  readonly richViewer: RichViewerController;
  readonly localEvidence: LocalEvidenceController;
  readonly search: SearchController;
  readonly comments: CommentController;
  readonly overview: OverviewController;
  readonly dispose: () => void;
}
export interface ApplicationProps {
  readonly services: ApplicationServices;
  readonly renderFeature?: (context: FeatureContext, services: ApplicationServices) => ReactNode;
  readonly renderConnections?: (
    context: ConnectionsRenderContext,
    services: ApplicationServices,
  ) => ReactNode;
}
/** Called outside React StrictMode. Disposal belongs to the launch, never a route component. */
// eslint-disable-next-line react-refresh/only-export-components
export function createApplicationServices(http: HttpClient): ApplicationServices {
  const liveReads = createLiveReadOwner({ reader: createLiveChangeReader(http) });
  const companion = createCompanion(http);
  const operations = createOperationController(companion, http.processing);
  const custom = createCustomController({ http, operations });
  const advanced = createAdvancedController({ client: http, operations });
  const connections = createConnectionDraftStore();
  const work = createWorkController({ client: http, operations });
  const graph = createGraphController({ http, readController: work });
  const plans = createPlansController({ http, operations });
  const evidence = createEvidenceController({ http, operations });
  const workActions = createWorkActionsController({ client: http, operations });
  const workProgress = createWorkProgressController({ client: http, operations });
  const administration = createAdministrationController({ http, operations });
  const history = createHistoryController({ http, operations });
  const historyAnalytics = createHistoryAnalyticsController({ http, operations });
  const threads = createThreadsController({ http, operations });
  const requests = createRequestsController({ http, operations });
  const participants = createParticipantsController({ http, operations });
  const coordination = createCoordinationController({ http, operations });
  const resources = createResourcesController({ http, operations });
  const resourceDrafts = createResourceDraftController(operations);
  const resourceUploads = createResourceUploadController(http);
  const facts = createFactsController({ http, operations });
  const richViewer = createRichViewerController({ http });
  const localEvidence = createLocalEvidenceController({ http, operations });
  const search = createSearchController({ http }),
    comments = createCommentController({ http }),
    overview = createOverviewController({ http });
  return Object.freeze({
    http,
    liveReads,
    custom,
    companion,
    operations,
    advanced,
    connections,
    work,
    graph,
    plans,
    evidence,
    workActions,
    workProgress,
    administration,
    history,
    historyAnalytics,
    threads,
    requests,
    participants,
    coordination,
    resources,
    resourceDrafts,
    resourceUploads,
    facts,
    richViewer,
    localEvidence,
    search,
    comments,
    overview,
    dispose: () => {
      liveReads.dispose();
      custom.dispose();
      search.dispose();
      comments.dispose();
      overview.dispose();
      localEvidence.dispose();
      richViewer.dispose();
      resources.dispose();
      resourceDrafts.dispose();
      resourceUploads.dispose();
      facts.dispose();
      plans.dispose();
      graph.dispose();
      evidence.dispose();
      administration.dispose();
      historyAnalytics.dispose();
      history.dispose();
      requests.dispose();
      threads.dispose();
      coordination.dispose();
      participants.dispose();
      workProgress.dispose();
      workActions.dispose();
      connections.dispose();
      operations.dispose();
      advanced.dispose();
      work.dispose();
      http.processing.dispose();
    },
  });
}
export function Application({ services, renderFeature, renderConnections }: ApplicationProps) {
  return (
    <App
      client={services.http}
      renderCommandSearch={(context, mode) => (
        <SearchFeature context={context} controller={services.search} mode={mode} />
      )}
      renderConnections={(context) =>
        renderConnections ? (
          renderConnections(context, services)
        ) : (
          <ConnectionManager
            {...context}
            operations={services.operations}
            store={services.connections}
            renderAdministration={() => (
              <AdministrationFeature
                selection={{
                  client: services.http,
                  connection: null,
                  current: true,
                  route: context.route,
                  writer: context.writer,
                }}
                controller={services.administration}
                operations={services.operations}
                hostOnly
              />
            )}
          />
        )
      }
      renderFeature={(context) => {
        const render = () => {
          if (renderFeature) return renderFeature(context, services);
          if (context.route.view === "saved")
            return (
              <CustomViewsFeature
                context={context}
                controller={services.custom}
                operations={services.operations}
              />
            );
          const openEvidence = (target: TicketEvidenceTarget) =>
            context.navigate(
              resourceRoute({
                ...target,
                content: { version: target.version, expectedDigest: target.digest },
              }),
            );
          if (context.route.view === "resources")
            return (
              <ResourcesFeature
                context={context}
                controller={services.resources}
                drafts={services.resourceDrafts}
                uploads={services.resourceUploads}
                operations={services.operations}
                renderContent={(content) => (
                  <CustomValuePresentation
                    identity={`${content.pin.connection.id}:${content.pin.connection.generation}:${content.pin.workspaceId}:${content.pin.resourceId}:${content.pin.version}:${content.pin.digest}`}
                    association={{
                      connectionId: content.pin.connection.id,
                      generation: content.pin.connection.generation,
                      socket: content.pin.connection.socket,
                      workspaceId: content.pin.workspaceId,
                    }}
                    subject={{
                      entity: "resource",
                      mimeType: content.source.hints.mime ?? content.pin.mimeType,
                    }}
                    content={{
                      kind: "bytes",
                      bytes: content.source.bytes,
                      complete:
                        content.source.completeness === "complete" &&
                        BigInt(content.source.bytes.byteLength) === BigInt(content.pin.sizeBytes),
                      verified: true,
                    }}
                    controller={services.custom}
                    processing={services.http.processing}
                    generic={
                      <ResourceViewer
                        content={content}
                        controller={services.richViewer}
                        http={context.client}
                      />
                    }
                  />
                )}
              />
            );
          if (context.route.view === "facts") {
            const render = (selection?: FactSelection) => (
              <FactsFeature
                {...(selection === undefined ? {} : { selection })}
                context={context}
                controller={services.facts}
                operations={services.operations}
                renderValue={(capture, generic) =>
                  capture.value.kind !== "value" ? (
                    generic
                  ) : (
                    <CustomValuePresentation
                      identity={`${capture.target.connection.id}:${capture.target.connection.generation}:${capture.target.workspaceId}:${capture.target.scope.kind}:${"id" in capture.target.scope ? capture.target.scope.id : ""}:${capture.value.key}:${capture.value.revision}:${capture.revision}`}
                      association={{
                        connectionId: capture.target.connection.id,
                        generation: capture.target.connection.generation,
                        socket: capture.target.connection.socket,
                        workspaceId: capture.target.workspaceId,
                      }}
                      subject={{ entity: "fact", key: capture.value.key }}
                      content={{
                        kind: "value",
                        value: capture.value.value,
                        complete: !capture.partial,
                      }}
                      controller={services.custom}
                      processing={services.http.processing}
                      generic={generic}
                    />
                  )
                }

                canOpenReference={(target, reference) =>
                  reference.kind === "resource"
                    ? canOpenResource({
                        connectionId: target.connection.id,
                        generation: target.connection.generation,
                        workspaceId: target.workspaceId,
                        resourceId: reference.id,
                        content: null,
                      })
                    : target.connection.id === context.connection.id &&
                      target.connection.generation === context.connection.generation &&
                      target.connection.socket === context.connection.socket &&
                      context.profileState === "current"
                }
                openReference={(target, reference) => {
                  if (reference.kind === "resource")
                    context.navigate(
                      resourceRoute({
                        connectionId: target.connection.id,
                        generation: target.connection.generation,
                        workspaceId: target.workspaceId,
                        resourceId: reference.id,
                        content: null,
                      }),
                    );
                  else if (
                    target.connection.id === context.connection.id &&
                    target.connection.generation === context.connection.generation &&
                    target.connection.socket === context.connection.socket &&
                    context.profileState === "current"
                  )
                    context.navigate({
                      view: "work",
                      connectionId: target.connection.id,
                      workspaceId: target.workspaceId,
                      projectId: null,
                      entityId: reference.id,
                    });
                }}
              />
            );
            return context.route.fact === undefined ? (
              render()
            ) : (
              <FactDestination context={context} render={render} />
            );
          }
          if (context.route.planning !== undefined) {
            const target = planningTargetFromRoute(context.route);
            return target === null ? (
              <StatePanel kind="error" title="Invalid recorded planning target">
                <p>The target cannot be resolved without its exact endpoint and identifiers.</p>
              </StatePanel>
            ) : (
              <PlanningTargetFeature context={context} target={target} />
            );
          }
          if (context.route.view === "advanced")
            return (
              <AdvancedFeature
                context={context}
                operations={services.operations}
                controller={services.advanced}
              />
            );
          if (context.route.view === "work")
            return (
              <WorkActionsFeature
                askTicket={(target) => askAboutTicket(services.requests, target)}
                context={context}
                readController={services.work}
                controller={services.workActions}
                operations={services.operations}
                renderProgress={(target) => (
                  <WorkProgressFeature
                    target={target}
                    controller={services.workProgress}
                    operations={services.operations}
                    openEvidence={openEvidence}
                    openDiscussion={(target) => context.navigate(discussionRoute(context, target))}
                  />
                )}
              />
            );
          if (context.route.view === "workflow")
            return (
              <WorkflowFeature
                askTicket={(target) => askAboutTicket(services.requests, target)}
                localEvidence={services.localEvidence}
                plans={services.plans}
                context={context}
                controller={services.graph}
                readController={services.work}
                actions={services.workActions}
                operations={services.operations}
                renderProgress={(target) => (
                  <WorkProgressFeature
                    target={target}
                    controller={services.workProgress}
                    operations={services.operations}
                    openEvidence={openEvidence}
                    openDiscussion={(target) => context.navigate(discussionRoute(context, target))}
                  />
                )}
                renderInspectorSections={(selection) => (
                  <EvidenceFeature
                    context={selection.context}
                    ticketId={selection.ticket.value.ticket.ticket_id}
                    graphRevision={selection.ticket.revision}
                    openEvidence={openEvidence}
                    controller={services.evidence}
                    operations={services.operations}
                  />
                )}
              />
            );
          if (context.route.view === "discussions" && context.route.discussion?.kind === "comment")
            return <CommentFeature context={context} controller={services.comments} />;
          if (context.route.view === "discussions")
            return (
              <RequestsFeature
                context={context}
                controller={services.requests}
                operations={services.operations}
                renderDiscussions={(slots) => (
                  <ThreadsFeature
                    context={context}
                    controller={services.threads}
                    operations={services.operations}
                    {...slots}
                  />
                )}
                onReply={(target) => {
                  const selected = { ...target, kind: "thread" as const };
                  const route = discussionRoute(context, selected);
                  services.threads.open({ ...context, route }, selected);
                  services.threads.create({
                    method: "thread.reply",
                    threadId: target.threadId,
                    body: "",
                    kind: "comment",
                    replyToId: "",
                  });
                  context.navigate(route);
                }}
              />
            );
          if (context.route.view === "history")
            return (
              <HistoryFeature
                context={context}
                controller={services.history}
                operations={services.operations}
                renderPayload={(capture, generic) => {
                  const shared = services.custom.get().shared;
                  const catalog =
                    shared.kind === "ready"
                      ? shared.value
                      : "previous" in shared
                        ? shared.previous
                        : undefined;
                  const original = catalog?.capture.scope.connection;
                  const profile =
                    original?.id === capture.scope.connectionId &&
                    original.generation === capture.scope.generation &&
                    catalog?.capture.scope.workspaceId === capture.scope.workspaceId
                      ? original
                      : context.connection.id === capture.scope.connectionId &&
                          context.connection.generation === capture.scope.generation
                        ? context.connection
                        : null;
                  return profile === null ? (
                    generic
                  ) : (
                    <CustomValuePresentation
                      identity={capture.source.key}
                      association={{
                        connectionId: capture.scope.connectionId,
                        generation: capture.scope.generation,
                        socket: profile.socket,
                        workspaceId: capture.scope.workspaceId,
                      }}
                      subject={{ entity: "history" }}
                      content={{
                        kind: "bytes",
                        bytes: capture.source.bytes,
                        complete: capture.complete,
                        verified: capture.verified,
                      }}
                      controller={services.custom}
                      processing={services.http.processing}
                      generic={generic}
                    />
                  );
                }}

                renderSearch={(selection) => (
                  <HistoryAnalyticsFeature
                    context={context}
                    selection={selection}
                    history={services.history}
                    controller={services.historyAnalytics}
                    operations={services.operations}
                  />
                )}
                canNavigateTarget={(target) =>
                  target.kind === "resource-version"
                    ? canOpenResource({
                        ...target,
                        resourceId: target.resourceId,
                        content: { version: target.contentVersion, expectedDigest: null },
                      })
                    : canOpenHistoryRun(target) || canOpenPlanningScope(target)
                }
                onNavigateTarget={(target) => {
                  if (
                    target.kind === "resource-version" &&
                    canOpenResource({
                      ...target,
                      content: { version: target.contentVersion, expectedDigest: null },
                    })
                  )
                    context.navigate(
                      resourceRoute({
                        ...target,
                        content: { version: target.contentVersion, expectedDigest: null },
                      }),
                    );
                  else if (target.kind === "scope" && canOpenPlanningScope(target))
                    context.navigate(planningRoute(planningTarget(target)));
                  else if (target.kind === "run" && canOpenHistoryRun(target))
                    context.navigate(historyRunRoute(target));
                }}
              />
            );
          if (context.route.view === "participants")
            return (
              <ParticipantsWorkspace
                context={context}
                controller={services.coordination}
                operations={services.operations}
                records={
                  <ParticipantsFeature
                    context={context}
                    controller={services.participants}
                    operations={services.operations}
                  />
                }
              />
            );
          if (context.route.view === "overview")
            return (
              <OverviewFeature
                context={context}
                controller={services.overview}
                renderManagement={(section) =>
                  section === "maintenance" ? (
                    <AdministrationFeature
                      selection={{
                        client: context.client,
                        connection: context.connection,
                        current: context.profileState === "current",
                        route: context.route,
                        writer: context.writer,
                      }}
                      controller={services.administration}
                      operations={services.operations}
                    />
                  ) : (
                    <ConnectionLifecycleFeature
                      context={context}
                      operations={services.operations}
                      store={services.connections}
                      section={section}
                    />
                  )
                }
              />
            );
          if (context.route.view === "activity")
            return <ActivityFeature context={context} controller={services.overview} />;
          return (
            <StatePanel kind="unavailable" title="This view is unavailable">
              <p>This view is unavailable in the current build.</p>
            </StatePanel>
          );
        };
        return (
          <LiveReads context={context} services={services}>
            {context.route.workbench === undefined ? (
              render()
            ) : (
              <WorkbenchDestination context={context} render={render} />
            )}
          </LiveReads>
        );
      }}
    />
  );
}
