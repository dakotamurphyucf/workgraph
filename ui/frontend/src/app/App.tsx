import {
  Component,
  Fragment,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { ConnectionProfile } from "../core/protocol/types";
import { Button, Badge, Select, StatePanel } from "../components/Primitives";
import { Icon } from "../components/Icon";
import { ResizablePane } from "../components/ResizablePane";
import { Dialog } from "../components/Dialog";
import { CommandPalette } from "./CommandPalette";
import { ConnectionsDialog } from "./SelectionDialogs";
import { ActorAccessContext } from "../components/ActorAccess";
import { ActorAvatar } from "../components/ActorAvatar";
import { selectionKey, useRememberedWriter, useProjectPins } from "./local-selections";
import { SidebarScope, PinnedProjects } from "./SidebarScope";
import { useScopeChoices } from "./scope-choices";
import { validIdentifier } from "./navigation";
import { WriterDialog } from "./WriterDialog";
import { ScopeDialog } from "./ScopeDialog";
import { failureMessage, useConnections, type ConnectionDirectory } from "./connections";
import {
  changeConnection,
  changeView,
  EMPTY_ROUTE,
  NAVIGATION,
  parseRoute,
  routeHref,
} from "./navigation";
import { useTheme, type ThemePreference } from "./theme";
import type { AppProps, Route } from "./types";
import "../styles/tokens.css";
import "../styles/components.css";
import "../styles/shell.css";
import "./sidebar-design.css";
export type { AppProps, FeatureContext, Route, ViewId, WriterSelection } from "./types";

type Modal = "commands" | "connections" | "writer" | "scope" | "appearance" | null;
function subscribeHash(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => {
    window.removeEventListener("hashchange", listener);
  };
}
function currentHash() {
  return window.location.hash;
}
function serverHash() {
  return "";
}

interface BoundaryState {
  readonly failed: boolean;
}
class ShellBoundary extends Component<{ readonly children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };
  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Workgraph shell failed unexpectedly.", error, info.componentStack);
  }
  override render() {
    return this.state.failed ? (
      <main className="wg-crash">
        <StatePanel
          kind="error"
          title="Workgraph could not render this view"
          action={
            <Button
              onClick={() => {
                window.location.reload();
              }}
            >
              Reload application
            </Button>
          }
        >
          <p>
            An unexpected application error occurred. Existing daemon data and saved operation
            journals remain on the companion. Reload to reconnect; an interrupted write must be
            recovered through its operation record.
          </p>
        </StatePanel>
      </main>
    ) : (
      this.props.children
    );
  }
}
/** Root bootstrap supplies the launch-capability-bound client; this component never invents daemon data. */
export function App(props: AppProps) {
  return (
    <ShellBoundary>
      <Application {...props} />
    </ShellBoundary>
  );
}
function Application({ client, renderFeature, renderConnections, renderCommandSearch }: AppProps) {
  const hash = useSyncExternalStore(subscribeHash, currentHash, serverHash);
  const parsed = parseRoute(hash);
  const route = parsed.ok ? parsed.route : EMPTY_ROUTE;
  const [disconnected, setDisconnected] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [mobileNavigation, setMobileNavigation] = useState(false);
  const [writerReturn, setWriterReturn] = useState<Modal>(null);
  const [actorPrompt, setActorPrompt] = useState(false);
  const { directory, defaultConnectionId, refresh } = useConnections(client);
  const { preference, setPreference } = useTheme();
  const content = useRef<HTMLElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const previousHash = useRef(hash);
  const profiles = directory.kind !== "crashed" ? (directory.items ?? []) : [];
  const resolvedConnectionId = route.connectionId ?? (disconnected ? null : defaultConnectionId);
  const connection = profiles.find((profile) => profile.id === resolvedConnectionId);
  const localKey = selectionKey(connection, route.workspaceId);
  const rememberedWriter = useRememberedWriter(localKey);
  const writer = rememberedWriter.value;
  const setWriter = rememberedWriter.set;
  const projectPins = useProjectPins(localKey);
  const workspaces = useScopeChoices(client, connection, null);
  const projects = useScopeChoices(
    client,
    connection,
    route.workspaceId,
    route.workspaceId !== null && validIdentifier(route.workspaceId),
  );
  const scopeProps = {
    route: { ...route, connectionId: connection?.id ?? route.connectionId },
    workspaces,
    projects,
    pins: projectPins.value,
    onPins: projectPins.set,
    navigate,
    onManage: () => setModal("scope"),
  };
  function chooseActor() {
    setWriterReturn(modal === "writer" ? null : modal);
    setActorPrompt(true);
    setModal("writer");
  }

  const selected = NAVIGATION.find((item) => item.id === route.view) ?? NAVIGATION[0];
  function navigate(next: Route) {
    window.location.assign(routeHref(next));
    setModal(null);
    setMobileNavigation(false);
  }
  function effectiveRoute(): Route {
    return { ...route, connectionId: connection?.id ?? route.connectionId };
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setModal((value) => (value === "commands" ? null : "commands"));
      }
      if (event.key === "Escape" && !document.querySelector("dialog[open]"))
        setMobileNavigation(false);
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
    };
  }, []);
  useEffect(() => {
    if (previousHash.current !== hash) {
      content.current?.focus();
      previousHash.current = hash;
    }
  }, [hash]);
  useEffect(() => {
    if (!mobileNavigation) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    navigation.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [mobileNavigation]);
  if (directory.kind === "crashed") throw directory.error;
  const connectionLabel = connection?.label || connection?.id || "Choose connection";
  return (
    <ActorAccessContext.Provider value={{ actorId: writer.actorId, choose: chooseActor }}>
      <div className="wg-shell">
        <a
          href="#wg-content"
          className="wg-skip"
          onClick={(event) => {
            event.preventDefault();
            content.current?.focus();
          }}
        >
          Skip to content
        </a>
        {mobileNavigation && (
          <button
            type="button"
            className="wg-nav-scrim"
            aria-label="Close navigation"
            onClick={() => {
              setMobileNavigation(false);
            }}
          />
        )}
        <ResizablePane
          id="wg-navigation"
          label="navigation"
          side="start"
          initialWidth={260}
          minimum={228}
          maximum={340}
          className={`wg-sidebar ${mobileNavigation ? "wg-sidebar--open" : ""}`}
        >
          <aside
            ref={navigation}
            aria-label="Workspace navigation"
            role={mobileNavigation ? "dialog" : undefined}
            aria-modal={mobileNavigation ? true : undefined}
            onKeyDown={(event) => {
              if (!mobileNavigation || event.key !== "Tab") return;
              const controls = event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), a[href], [tabindex='0']",
              );
              const first = controls[0];
              const last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              }
              if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <Button
              tone="quiet"
              className="wg-mobile-close"
              onClick={() => {
                setMobileNavigation(false);
              }}
            >
              <Icon name="close" /> Close navigation
            </Button>
            <button
              type="button"
              className="wg-workspace-switch"
              onClick={() => {
                setModal("connections");
              }}
            >
              <span className="wg-logo" aria-hidden="true">
                w
              </span>
              <span className="wg-grow">
                <strong>Workgraph</strong>
                <small>{connectionLabel}</small>
              </span>
              <Icon name="chevron" />
            </button>
            <button
              type="button"
              className="wg-search-trigger"
              onClick={() => {
                setModal("commands");
              }}
            >
              <Icon name="search" />
              <span>Find or jump to…</span>
              <kbd>⌘ K</kbd>
            </button>
            <div className="wg-sidebar-scroll">
              <SidebarScope key={localKey} {...scopeProps} />
              <nav aria-label="Primary">
                {NAVIGATION.map((item) => (
                  <Fragment key={item.id}>
                    {(item.id === "overview" ||
                      item.id === "history" ||
                      item.id === "activity") && (
                      <div className="wg-section-label">
                        {item.id === "overview"
                          ? "Workspace"
                          : item.id === "history"
                            ? "Knowledge"
                            : "Tools & activity"}
                      </div>
                    )}
                    <a
                      data-nav-view={item.id}
                      title={item.description}
                      href={routeHref(changeView(effectiveRoute(), item.id))}
                      aria-current={parsed.ok && route.view === item.id ? "page" : undefined}
                      onClick={() => {
                        setMobileNavigation(false);
                      }}
                    >
                      <Icon name={item.icon} />
                      <span>{item.label}</span>
                    </a>
                  </Fragment>
                ))}
              </nav>
              <PinnedProjects {...scopeProps} />
            </div>
            <div className="wg-sidebar-bottom">
              <button
                type="button"
                className="wg-connection-status"
                onClick={() => {
                  setModal("connections");
                }}
              >
                <span
                  className={`wg-status-dot ${directory.kind === "ready" ? "wg-status-dot--available" : ""}`}
                  aria-hidden="true"
                />
                <span>
                  {directory.kind === "loading"
                    ? "Connecting to companion…"
                    : directory.kind === "ready"
                      ? "Companion reachable"
                      : "Companion unavailable"}
                </span>
              </button>
              <button
                type="button"
                className="wg-actor-trigger"
                data-readonly={writer.actorId === null}
                onClick={() => {
                  setModal("writer");
                }}
              >
                <ActorAvatar actor={writer.actorId} />
                <span className="wg-grow">
                  <strong>{writer.actorId ?? "No acting actor"}</strong>
                  <small>
                    {writer.runId
                      ? `Run · ${writer.runId}`
                      : writer.actorId
                        ? "Change actor or choose a run"
                        : "Choose an actor to make changes"}
                  </small>
                </span>
                <Icon name="chevron" />
              </button>
            </div>
          </aside>
        </ResizablePane>
        <div className="wg-main" inert={mobileNavigation}>
          <header className="wg-topbar">
            <Button
              tone="quiet"
              className="wg-icon-button wg-mobile-menu"
              aria-label="Open navigation"
              aria-expanded={mobileNavigation}
              aria-controls="wg-navigation"
              onClick={() => {
                setMobileNavigation(true);
              }}
            >
              <Icon name="menu" />
            </Button>
            <div className="wg-breadcrumbs">
              <button
                type="button"
                onClick={() => {
                  setModal("connections");
                }}
              >
                {connectionLabel}
              </button>
              <span aria-hidden="true">/</span>
              <button
                type="button"
                onClick={() => {
                  setModal("scope");
                }}
              >
                {projects.data?.items.find((item) => item.id === route.projectId)?.title ||
                  route.projectId ||
                  workspaces.data?.items.find((item) => item.id === route.workspaceId)?.title ||
                  route.workspaceId ||
                  "All workspaces"}
              </button>
              <span aria-hidden="true">/</span>
              <span aria-current="page">{selected?.label ?? "Overview"}</span>
            </div>
            <div className="wg-topbar-actions">
              <button
                type="button"
                className="qs-identity"
                data-readonly={writer.actorId === null}
                onClick={() => {
                  setActorPrompt(false);
                  setWriterReturn(null);
                  setModal("writer");
                }}
                title={
                  writer.actorId
                    ? `Acting as ${writer.actorId}${writer.runId ? ` · run ${writer.runId}` : ""}`
                    : "Choose an actor to make changes"
                }
              >
                <ActorAvatar actor={writer.actorId} />
                <span>
                  {writer.actorId ? `Acting as ${writer.actorId}` : "Read-only · Choose actor"}
                </span>
              </button>
              {rememberedWriter.unavailable && (
                <span className="qs-storage-warning">Identity kept for this tab only</span>
              )}
              {projectPins.unavailable && (
                <span className="qs-storage-warning">Pins kept for this tab only</span>
              )}
              <span id="wg-live-status" />
              <Button
                tone="quiet"
                className="wg-icon-button"
                aria-label="Refresh connection"
                onClick={refresh}
                disabled={directory.kind === "loading"}
              >
                <Icon name="refresh" />
              </Button>
              <Badge>Local</Badge>
              <Button
                tone="quiet"
                className="wg-icon-button"
                aria-label="Appearance settings"
                onClick={() => {
                  setModal("appearance");
                }}
              >
                <Icon name={preference === "light" ? "sun" : "moon"} />
              </Button>
            </div>
          </header>
          <main
            id="wg-content"
            className="wg-content"
            data-view={route.view}
            tabIndex={-1}
            ref={content}
            aria-label={selected?.label ?? "Overview"}
          >
            {!parsed.ok ? (
              <StatePanel
                kind="error"
                title="This link could not be opened"
                action={
                  <Button
                    onClick={() => {
                      navigate(EMPTY_ROUTE);
                    }}
                  >
                    Open overview
                  </Button>
                }
              >
                <p>{parsed.message}</p>
              </StatePanel>
            ) : (
              <>
                {((route.view !== "overview" &&
                  route.view !== "work" &&
                  route.view !== "activity" &&
                  route.view !== "workflow" &&
                  route.view !== "history" &&
                  route.view !== "discussions" &&
                  route.view !== "participants" &&
                  route.view !== "resources" &&
                  route.view !== "facts" &&
                  route.view !== "saved" &&
                  route.view !== "advanced") ||
                  route.planning !== undefined) && (
                  <div
                    className={`wg-page-heading${route.view === "overview" && route.planning === undefined ? " ov-shell-heading" : ""}`}
                  >
                    {((route.view !== "overview" &&
                      route.view !== "work" &&
                      route.view !== "activity" &&
                      route.view !== "workflow" &&
                      route.view !== "history" &&
                      route.view !== "discussions" &&
                      route.view !== "participants" &&
                      route.view !== "resources" &&
                      route.view !== "facts" &&
                      route.view !== "saved" &&
                      route.view !== "advanced") ||
                      route.planning !== undefined) && (
                      <div>
                        <h1>{selected?.label ?? "Overview"}</h1>
                        <p>{selected?.description}</p>
                      </div>
                    )}
                    <Button onClick={refresh} disabled={directory.kind === "loading"}>
                      <Icon name="refresh" />
                      Refresh connection
                    </Button>
                  </div>
                )}
                {((route.view !== "overview" &&
                  route.view !== "work" &&
                  route.view !== "activity" &&
                  route.view !== "workflow" &&
                  route.view !== "history" &&
                  route.view !== "discussions" &&
                  route.view !== "participants" &&
                  route.view !== "resources" &&
                  route.view !== "facts" &&
                  route.view !== "saved" &&
                  route.view !== "advanced") ||
                  route.planning !== undefined) && (
                  <div className="wg-scope-summary">
                    <span>
                      <Icon name="connection" />
                      {connection
                        ? `${connectionLabel} · generation ${connection.generation}`
                        : "No connection selected"}
                    </span>
                    <span>
                      {writer.actorId
                        ? `Acting as ${writer.actorId}`
                        : "No actor selected · reads available"}
                    </span>
                  </div>
                )}
                <ConnectionSurface
                  directory={directory}
                  connection={connection}
                  requestedId={resolvedConnectionId}
                  onRefresh={refresh}
                  onConnections={() => {
                    setModal("connections");
                  }}
                >
                  {connection &&
                    (renderFeature ? (
                      <div
                        key={`${connection.id}:${connection.generation}:${route.workspaceId ?? ""}:${route.projectId ?? ""}`}
                        className="wg-feature-surface"
                      >
                        {renderFeature({
                          client,
                          connection,
                          profileState:
                            directory.kind === "ready"
                              ? "current"
                              : directory.kind === "loading"
                                ? "refreshing"
                                : "unavailable",
                          route: effectiveRoute(),
                          writer,
                          navigate,
                        })}
                      </div>
                    ) : (
                      <UnconnectedFeature
                        view={selected?.label ?? "View"}
                        connection={connection}
                      />
                    ))}
                </ConnectionSurface>
              </>
            )}
          </main>
          {route.view !== "overview" &&
            route.view !== "work" &&
            route.view !== "activity" &&
            route.view !== "workflow" &&
            route.view !== "history" && (
              <footer className="wg-statusbar">
                <span>
                  {connection ? "Saved profile · daemon status unchecked" : "No daemon selected"}
                </span>
                <span>Selection never transfers ownership</span>
              </footer>
            )}
        </div>
        {modal === "commands" && (
          <CommandPalette
            {...(renderCommandSearch === undefined
              ? {}
              : {
                  renderSearch: (mode: "jump" | "search") =>
                    renderCommandSearch(
                      {
                        connection: connection ?? null,
                        profiles,
                        route: effectiveRoute(),
                        navigate,
                        onClose: () => setModal(null),
                      },
                      mode,
                    ),
                })}
            onClose={() => {
              setModal(null);
            }}
            onNavigate={(view) => {
              navigate(changeView(effectiveRoute(), view));
            }}
            onConnections={() => {
              setModal("connections");
            }}
            onWriter={() => {
              setModal("writer");
            }}
            onScope={() => {
              setModal("scope");
            }}
          />
        )}
        {(modal === "connections" || (modal === "writer" && writerReturn === "connections")) &&
          (renderConnections ? (
            <Dialog
              title="Daemon connections"
              wide
              description="Choose where Workgraph runs. A daemon is the background service that stores and manages your workspaces; this UI connects to it through a saved address."
              onClose={() => {
                setModal(null);
              }}
            >
              {renderConnections({
                client,
                profiles,
                selectedId: connection?.id ?? null,
                route: effectiveRoute(),
                writer,
                navigate,
                onProfilesChanged: refresh,
                onDisconnect: () => {
                  setDisconnected(true);
                  navigate(changeConnection(route, null));
                },
                onSelect: (id) => {
                  setDisconnected(false);
                  navigate(changeConnection(route, id));
                },
                onClose: () => {
                  setModal(null);
                },
              })}
            </Dialog>
          ) : (
            <ConnectionsDialog
              profiles={profiles}
              selectedId={connection?.id ?? null}
              onSelect={(id) => {
                navigate(changeConnection(route, id));
              }}
              onClose={() => {
                setModal(null);
              }}
              onRefresh={() => {
                refresh();
                setModal(null);
              }}
            />
          ))}
        {modal === "writer" && (
          <WriterDialog
            client={client}
            connection={connection}
            workspaceId={route.workspaceId}
            writer={writer}
            prompt={
              actorPrompt
                ? "Choose an actor, then return to the action you selected. Nothing will be submitted automatically."
                : undefined
            }
            storageUnavailable={rememberedWriter.unavailable}
            onSelect={(next) => {
              setWriter(next);
              setModal(writerReturn);
              setWriterReturn(null);
              setActorPrompt(false);
            }}
            onClose={() => {
              setModal(writerReturn);
              setWriterReturn(null);
              setActorPrompt(false);
            }}
          />
        )}
        {modal === "scope" && (
          <ScopeDialog
            client={client}
            connection={connection}
            route={effectiveRoute()}
            onSelect={navigate}
            onClose={() => {
              setModal(null);
            }}
          />
        )}
        {modal === "appearance" && (
          <Dialog
            title="Appearance"
            description="Typography and spacing follow your browser text size. Both themes preserve the same layout and controls."
            onClose={() => {
              setModal(null);
            }}
          >
            <Select
              label="Theme"
              value={preference}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "system" || value === "dark" || value === "light")
                  setPreference(value satisfies ThemePreference);
              }}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </Select>
            <div className="wg-form-actions">
              <Button
                onClick={() => {
                  setModal(null);
                }}
              >
                Done
              </Button>
            </div>
          </Dialog>
        )}
      </div>
    </ActorAccessContext.Provider>
  );
}
function ConnectionSurface({
  directory,
  connection,
  requestedId,
  onRefresh,
  onConnections,
  children,
}: {
  readonly directory: ConnectionDirectory;
  readonly connection: ConnectionProfile | undefined;
  readonly requestedId: string | null;
  readonly onRefresh: () => void;
  readonly onConnections: () => void;
  readonly children: ReactNode;
}) {
  if (directory.kind === "crashed") throw directory.error;
  const retained = directory.kind !== "ready" && connection !== undefined;
  const status = retained ? (
    <StatePanel
      kind="partial"
      title={
        directory.kind === "loading"
          ? "Refreshing connection profiles"
          : "Connection profile refresh failed"
      }
      action={
        directory.kind === "failed" ? <Button onClick={onRefresh}>Try again</Button> : undefined
      }
    >
      <p>
        {directory.kind === "failed"
          ? failureMessage(directory.failure)
          : "Checking the saved connection directory."}{" "}
        Showing the last received profile. Existing view state and drafts are retained; daemon
        health is not inferred.
      </p>
    </StatePanel>
  ) : null;
  let body: ReactNode;
  if (retained || (directory.kind === "ready" && connection)) body = children;
  else if (directory.kind === "loading")
    body = (
      <StatePanel kind="loading" title="Connecting to your companion">
        <p>Reading saved connection profiles. No daemon state has been loaded yet.</p>
      </StatePanel>
    );
  else if (directory.kind === "failed")
    body = (
      <StatePanel
        kind={directory.failure.kind === "network" ? "offline" : "error"}
        title={
          directory.failure.kind === "network"
            ? "Companion is unavailable"
            : "Connection profiles could not be loaded"
        }
        action={<Button onClick={onRefresh}>Try again</Button>}
      >
        <p>{failureMessage(directory.failure)}</p>
        <p>
          Check that the local companion is running. Try again reloads its saved connection
          profiles.
        </p>
      </StatePanel>
    );
  else if (directory.items.length === 0)
    body = (
      <StatePanel
        kind="empty"
        title="Connect your first daemon"
        action={<Button onClick={onConnections}>Connection profiles</Button>}
      >
        <p>
          Your companion has no saved connection profiles. Add a local daemon endpoint to open its
          workspaces.
        </p>
        <p className="wg-hint">Choose Connection profiles to save your first daemon endpoint.</p>
      </StatePanel>
    );
  else
    body = (
      <StatePanel
        kind="error"
        title="Saved connection not found"
        action={<Button onClick={onConnections}>Choose a connection</Button>}
      >
        <p>
          The requested profile <code>{requestedId}</code> is not in the current connection
          directory. Choose an existing profile; this link has not been redirected to a different
          daemon.
        </p>
      </StatePanel>
    );
  // Stable child position preserves mounted feature drafts through refresh/failure; a changed endpoint generation remounts explicitly.
  return (
    <div className="wg-connection-surface">
      {status}
      <div className="wg-connection-body">{body}</div>
    </div>
  );
}

function UnconnectedFeature({
  view,
  connection,
}: {
  readonly view: string;
  readonly connection: ConnectionProfile;
}) {
  return (
    <div className="wg-foundation">
      <div className="wg-foundation-context">
        <div className="wg-eyebrow">SAVED CONNECTION</div>
        <h2>{connection.label || connection.id}</h2>
        <dl>
          <div>
            <dt>Profile</dt>
            <dd>
              <code>{connection.id}</code>
            </dd>
          </div>
          <div>
            <dt>Generation</dt>
            <dd>
              <code>{connection.generation}</code>
            </dd>
          </div>
          <div>
            <dt>Daemon endpoint</dt>
            <dd>
              <code>{connection.socket}</code>
            </dd>
          </div>
          <div>
            <dt>Daemon health</dt>
            <dd>Not checked</dd>
          </div>
        </dl>
      </div>
      <StatePanel kind="unavailable" title={`${view} is not available yet`}>
        <p>This view is unavailable in the current build.</p>
        <p>You can review your saved connection, choose a scope, or switch the acting actor.</p>
      </StatePanel>
    </div>
  );
}
