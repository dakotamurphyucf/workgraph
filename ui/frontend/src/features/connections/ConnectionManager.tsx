import { Icon } from "../../components/Icon";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Badge, Button, Field, Panel, Toolbar } from "../../components/Primitives";
import { ObservationNotice } from "../../components/ObservationNotice";
import * as d from "../../core/protocol/decoders";
import type { ConnectionProfile } from "../../core/protocol/types";
import { createReadSlot } from "../../core/state/read-slot";
import { createConnectionsClient } from "./client";
import { freezeAction, newIdentity, observerContext, DraftInputError } from "./model";
import { OperationPanel } from "./shared";
import { failureText } from "./failure";
import type { DraftCell, ManagerDraft } from "./store";
import type { ConnectionManagerProps, DaemonCapabilities, Launch, LaunchPlan } from "./types";
import { CapturedValues } from "./CapturedValues";
import { ManagementPresentation } from "./management-presentation";
import { ConnectionIntro } from "./ConnectionIntro";
import "./connections.css";
import "./daemon-design.css";

function useManagerField<K extends keyof ManagerDraft>(
  cell: DraftCell<ManagerDraft>,
  key: K,
): readonly [ManagerDraft[K], (value: ManagerDraft[K]) => void] {
  const value = useSyncExternalStore(cell.subscribe, () => cell.get()[key]);
  const set = useCallback(
    (next: ManagerDraft[K]) => cell.set((previous) => ({ ...previous, [key]: next })),
    [cell, key],
  );
  return [value, set];
}
type LaunchDirectory = Awaited<ReturnType<ReturnType<typeof createConnectionsClient>["launches"]>>;
function readyText(launch: Launch): string {
  if (launch.state.status !== "ready") return launch.state.status.replaceAll("_", " ");
  switch (launch.state.observation) {
    case "existing_endpoint":
      return "Existing endpoint observed ready";
    case "startup_attempt_observed_ready":
      return "Startup attempt observed an endpoint ready";
    case "observed_competition":
      return "Competing startup observed ready";
  }
}
export function ConnectionManager(props: ConnectionManagerProps) {
  const {
    client,
    profiles,
    selectedId,
    route,
    writer,
    operations,
    store,
    onProfilesChanged,
    onSelect,
    onDisconnect,
    navigate,
  } = props;
  const [section, setSection] = useState<
    "profiles" | "profile" | "daemon" | "launches" | "administration"
  >("profiles");
  const draftIssue = useSyncExternalStore(store.manager.subscribe, store.manager.issue);
  const api = useMemo(() => createConnectionsClient(client), [client]);
  const observeLaunch = (initial: Launch) =>
    store.observeLaunch(initial, (plan, signal) =>
      api.inspectLaunch(plan.intention_id, plan, signal),
    );
  const [storedProfileId, setProfileId] = useManagerField(store.manager, "profileId");
  const profileId = storedProfileId ?? selectedId ?? profiles[0]?.id ?? "";
  const [savedProfile, setSavedProfile] = useManagerField(store.manager, "savedProfile");
  const profile =
    profiles.find((item) => item.id === profileId) ??
    (savedProfile?.id === profileId ? savedProfile : undefined);
  const [draft, setDraft] = useManagerField(store.manager, "draft");
  const [registry, setRegistry] = useManagerField(store.manager, "registry");
  const [log, setLog] = useManagerField(store.manager, "log");
  const [seconds, setSeconds] = useManagerField(store.manager, "seconds");
  const [frozen, setFrozen] = useManagerField(store.manager, "frozen");
  const [launch, setLaunch] = useManagerField(store.manager, "launch");
  const [launchObservation] = useManagerField(store.manager, "launchObservation");
  const recordLaunch = (next: Launch) => {
    if (next.state.status === "starting") observeLaunch(next);
    else setLaunch(next);
  };
  const [capabilities, setCapabilities] = useState<DaemonCapabilities | null>(null);
  const [notice, setNotice] = useManagerField(store.manager, "notice");
  const [busy, setBusy] = useManagerField(store.manager, "busy");
  const [unexpected, setUnexpected] = useManagerField(store.manager, "unexpected");
  const [stop, setStop] = useManagerField(store.manager, "stop");
  const [directory, setDirectory] = useState<LaunchDirectory | null>(null);
  const [directoryOffset, setDirectoryOffset] = useState("0");
  const [directoryBack, setDirectoryBack] = useState<readonly string[]>([]);
  const [hiddenPlan, setHiddenPlan] = useState<string | null>(null);
  const [attachSlot] = useState(() =>
    createReadSlot<{
      readonly connection: ConnectionProfile;
      readonly initialize: import("../../core/protocol/types").PublicResponse;
      readonly health: import("../../core/protocol/types").PublicResponse;
    }>(),
  );
  // The public attach result is a strict closed DTO; the slot owns cancellation and stale identities.
  const [attached, setAttached] = useState<{
    readonly profile: ConnectionProfile;
    readonly initialize: import("../../core/protocol/types").PublicResponse;
    readonly health: import("../../core/protocol/types").PublicResponse;
  } | null>(null);
  const attachedState = useSyncExternalStore(attachSlot.subscribe, attachSlot.get);
  useEffect(
    () => () => {
      attachSlot.clear();
    },
    [attachSlot, profile?.id, profile?.generation],
  );
  const [capabilitySlot] = useState(() => createReadSlot<DaemonCapabilities>());
  useEffect(() => {
    void capabilitySlot
      .load("local-paired-executable", (signal) => api.capabilities(signal))
      .then((result) => {
        if (result.ok) setCapabilities(result.data);
        else if (!("superseded" in result)) setNotice(failureText(result.failure));
      })
      .catch((error: unknown) => setUnexpected({ error }));
    return () => {
      capabilitySlot.clear();
    };
  }, [api, capabilitySlot, setNotice, setUnexpected]);
  const run = (task: () => Promise<void>) => {
    if (store.manager.get().busy) return;
    setBusy(true);
    setNotice("");
    void task()
      .catch((error: unknown) => {
        if (error instanceof DraftInputError) setNotice(error.message);
        else setUnexpected({ error });
      })
      .finally(() => setBusy(false));
  };
  const readDirectory = async (offset: string) => {
    const result = await api.launches(offset);
    setDirectory(result);
    if (!result.ok) setNotice(failureText(result.failure));
    else setDirectoryOffset(offset);
    return result.ok;
  };
  useEffect(() => {
    const controller = new AbortController();
    void api
      .launches("0", controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDirectory(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setUnexpected({ error });
      });
    return () => controller.abort();
  }, [api, setUnexpected]);
  const activeAttached =
    attached !== null &&
    profile !== undefined &&
    attached.profile.id === profile.id &&
    attached.profile.generation === profile.generation;
  const createLaunch = () => {
    if (frozen !== null) store.stopObservingLaunch(frozen.intention_id);
    if (profile === undefined)
      throw new DraftInputError("Save or select an explicit connection profile first.");
    const timeout = d.decimal.decode(d.jsonString(seconds));
    if (!timeout.ok || BigInt(timeout.value) < 1n || BigInt(timeout.value) > 300n)
      throw new DraftInputError("Startup timeout requires 1–300 seconds.");
    if (
      !registry.startsWith("/") ||
      !log.startsWith("/") ||
      registry.includes("\0") ||
      log.includes("\0")
    )
      throw new DraftInputError(
        "Registry and startup log require absolute paths on this companion host.",
      );
    const plan: LaunchPlan = {
      intention_id: newIdentity(),
      connection: { ...profile },
      context: observerContext(route, writer),
      registry,
      log,
      timeout_seconds: timeout.value,
    };
    setFrozen(plan);
    setLaunch(null);
    setNotice(
      "Startup plan captured for durable preparation; startup remains a separate explicit action.",
    );
    return plan;
  };
  if (unexpected !== null) throw unexpected.error;
  if (attachedState.kind === "unexpected_error") throw attachedState.error;
  return (
    <ManagementPresentation value={true}>
      <div className="wg-connections-manager" data-section={section}>
        <nav className="cm-tabs" aria-label="Connection sections">
          <Button
            data-tone="blue"
            aria-pressed={section === "profiles" || section === "profile"}
            onClick={() => setSection("profiles")}
          >
            <Icon name="connection" />
            Connections
          </Button>
          <Button
            data-tone="green"
            aria-pressed={section === "daemon"}
            disabled={profile === undefined}
            onClick={() => setSection("daemon")}
          >
            <Icon name="settings" />
            Daemon
          </Button>
          <Button
            data-tone="purple"
            aria-pressed={section === "launches"}
            onClick={() => setSection("launches")}
          >
            <Icon name="history" />
            Startup history
          </Button>
          {props.renderAdministration && (
            <Button
              data-tone="orange"
              aria-pressed={section === "administration"}
              onClick={() => setSection("administration")}
            >
              <Icon name="advanced" />
              Offline tools
            </Button>
          )}
        </nav>
        <ConnectionIntro section={section} />
        <div className="cm-scroll">
          {draftIssue !== null && (
            <p role="alert" className="wg-error">
              {draftIssue}
            </p>
          )}
          {notice !== "" && (
            <div className="wg-connections-notice">
              <p role="status">{notice}</p>
              <Button
                tone="quiet"
                aria-label="Dismiss connection message"
                onClick={() => setNotice("")}
              >
                <Icon name="close" />
              </Button>
            </div>
          )}

          {section !== "daemon" && (frozen !== null || stop !== null) && (
            <Button className="cm-review-link" onClick={() => setSection("daemon")}>
              Open captured startup or shutdown review
            </Button>
          )}
          <section
            hidden={section !== "profiles"}
            aria-label="Saved connections"
            className="cm-section"
          >
            <Panel
              title={profiles.length === 0 ? "Your first connection" : "Saved daemon profiles"}
              actions={
                <Button disabled={busy} onClick={onProfilesChanged}>
                  Refresh profiles
                </Button>
              }
            >
              {profiles.length > 0 && (
                <p className="cm-explainer">
                  A profile remembers a daemon’s address. Use a connection to browse its workspaces,
                  or choose Manage to check its status and control startup. Saving a profile does
                  not start or stop a daemon.
                </p>
              )}
              {profiles.length === 0 && (
                <p>
                  Save a socket profile below, then attach to a running daemon or prepare an
                  explicit local startup. No daemon starts automatically.
                </p>
              )}
              <div className="wg-connection-profiles">
                {profiles.map((item) => (
                  <article
                    key={item.id}
                    className={
                      item.id === profileId
                        ? "wg-connection-profile wg-connection-profile--selected"
                        : "wg-connection-profile"
                    }
                  >
                    <header>
                      <strong>
                        <Icon name="connection" />
                        {item.label}
                      </strong>
                      <Badge tone={item.id === selectedId ? "accent" : "neutral"}>
                        {item.id === selectedId ? "Selected in app" : "Saved address"}
                      </Badge>
                    </header>
                    <code>{item.socket}</code>
                    <p className="wg-hint">
                      {item.id} · generation {item.generation}
                    </p>
                    <Toolbar label={`${item.label} profile actions`}>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setProfileId(item.id);
                          setSavedProfile(null);
                          setAttached(null);
                          setSection("daemon");
                        }}
                      >
                        Manage
                      </Button>
                      <Button onClick={() => onSelect(item.id)}>Use connection</Button>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setDraft({
                            id: item.id,
                            label: item.label,
                            socket: item.socket,
                            previous: { ...item },
                          });
                          setProfileId(item.id);
                          setSection("profile");
                        }}
                      >
                        Edit profile
                      </Button>
                    </Toolbar>
                  </article>
                ))}
              </div>
            </Panel>

            <Toolbar label="Add a connection">
              <Button tone="primary" onClick={() => setSection("profile")}>
                <Icon name="plus" />
                {draft.previous === null ? "Add connection" : "Continue profile edit"}
              </Button>
            </Toolbar>
            <details className="cm-host-help">
              <summary>Connection paths and WSL</summary>
              <p className="wg-hint">
                Each profile points to a Unix socket on the companion host. If the companion runs in
                WSL, paths are inside that WSL environment; the browser connects only to this
                companion’s HTTP address. Actor selection is cooperative attribution, not
                authentication.
              </p>
            </details>
          </section>
          <section
            hidden={section !== "profile"}
            aria-label="Connection profile editor"
            className="cm-section cm-profile-editor"
          >
            <Button tone="quiet" onClick={() => setSection("profiles")}>
              ← Back to connections
            </Button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  const id = d.identifier.decode(d.jsonString(draft.id));
                  if (!id.ok)
                    throw new DraftInputError(
                      "Profile ID requires 1–96 ASCII letters, digits, underscores or hyphens.",
                    );
                  const result = await api.save({ ...draft, id: id.value });
                  if (!result.ok) {
                    setNotice(
                      `${failureText(result.failure)} Refresh profiles before an explicit new edit; no save was retried.`,
                    );
                    return;
                  }
                  setSavedProfile(result.data);
                  setProfileId(result.data.id);
                  setAttached(null);
                  onProfilesChanged();
                  setNotice(
                    `Saved ${result.data.label} generation ${result.data.generation}. Existing operations keep their original endpoint generation.`,
                  );
                  setDraft({ id: "", label: "", socket: "", previous: null });
                  setSection("daemon");
                });
              }}
            >
              <h3>
                <Icon name="connection" />{" "}
                {draft.previous === null ? "Add connection profile" : "Edit connection profile"}
              </h3>
              <p className="cm-explainer">
                {draft.previous === null
                  ? "Give this daemon a recognizable name and enter its socket path. Save profile adds the address to this UI; you can then connect to a running daemon or start one locally."
                  : "Update the name or socket address for future use. Saving does not move data or restart a daemon. Previously prepared actions keep the address they were created with."}
              </p>
              <div className="wg-lifecycle-fields">
                <Field
                  label="Profile ID"
                  hint="A short, unique name for this saved address, such as local-dev. Letters, numbers, underscores and hyphens; fixed after creation."
                  value={draft.id}
                  disabled={busy || draft.previous !== null}
                  onChange={(event) => setDraft({ ...draft, id: event.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={96}
                />
                <Field
                  label="Connection label"
                  hint="The friendly name shown in the sidebar and connection list, such as My development daemon."
                  disabled={busy}
                  value={draft.label}
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                  autoComplete="off"
                  maxLength={512}
                />
                <Field
                  label="Unix socket on companion host"
                  hint="The local address used by the daemon and this UI’s background server (the companion). Enter an absolute file path, not a web URL."
                  disabled={busy}
                  value={draft.socket}
                  onChange={(event) => setDraft({ ...draft, socket: event.target.value })}
                  placeholder="/absolute/path/workgraph.sock"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              {draft.previous !== null && (
                <p className="wg-hint">
                  Guarded by generation {draft.previous.generation}. Socket changes publish a new
                  immutable generation; they never retarget prepared actions.
                </p>
              )}
              <Toolbar label="Profile editing">
                <Button type="submit" tone="primary" disabled={busy}>
                  {draft.previous === null ? "Save profile" : "Save new generation"}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setDraft({ id: "", label: "", socket: "", previous: null });
                    setSection("profiles");
                  }}
                >
                  Discard profile draft
                </Button>
              </Toolbar>
            </form>
          </section>
          <section
            hidden={section !== "daemon"}
            aria-label="Selected daemon controls"
            className="cm-section"
          >
            {profile !== undefined && (
              <Panel
                title={`Manage ${profile.label}`}
                actions={
                  <Badge>{activeAttached ? "handshake observed" : "not checked here"}</Badge>
                }
              >
                <p>
                  <code>{profile.socket}</code> · generation {profile.generation}
                </p>
                <p className="wg-hint">
                  Check the daemon at this address, then use it to browse its workspaces. The status
                  below reflects the last check in this dialog, not continuous monitoring.
                </p>
                <Toolbar label="Connection lifecycle controls">
                  <Button
                    disabled={busy || attachedState.kind === "loading"}
                    onClick={() =>
                      run(async () => {
                        const captured = { ...profile };
                        const result = await attachSlot.load(
                          JSON.stringify([captured.id, captured.generation]),
                          (signal) => api.attach(captured, signal),
                        );
                        if (!result.ok) {
                          if (!("superseded" in result))
                            setNotice(
                              `${failureText(result.failure)} The daemon may still be running.`,
                            );
                          return;
                        }
                        if (
                          result.data.connection.id !== captured.id ||
                          result.data.connection.generation !== captured.generation ||
                          result.data.connection.socket !== captured.socket
                        )
                          throw new Error(
                            "Attach returned another connection; selection unchanged.",
                          );
                        setAttached({
                          profile: captured,
                          initialize: result.data.initialize,
                          health: result.data.health,
                        });
                        setNotice(
                          "The daemon answered the connection and health checks. You can now use this connection to browse its workspaces; the result reflects this check only.",
                        );
                      })
                    }
                  >
                    Attach & inspect capabilities
                  </Button>
                  <Button onClick={() => onSelect(profile.id)}>Use this connection</Button>
                  <Button
                    onClick={() => {
                      setAttached(null);
                      onDisconnect();
                    }}
                  >
                    Disconnect selection
                  </Button>
                </Toolbar>
                <p className="wg-hint">
                  Attach checks the protocol and health without changing your selected workspace.
                  Use this connection selects it in the app. Disconnect clears the app’s selection;
                  the daemon keeps running.
                </p>

                {activeAttached && attached !== null && (
                  <details className="cm-health">
                    <summary>
                      <Icon name="check" /> Latest connection check
                    </summary>
                    <p>
                      The daemon answered the protocol and health checks for this exact address.
                      These are observations from your last Attach action; check again after
                      restarting or changing the daemon.
                    </p>
                    <h4>Protocol and capabilities</h4>
                    <CapturedValues value={attached.initialize.data} />
                    <h4>Daemon health</h4>
                    <CapturedValues value={attached.health.data} />
                  </details>
                )}
                <details className="cm-startup">
                  <summary>
                    <Icon name="plus" />
                    Start a local daemon
                  </summary>
                  <p>
                    Choose local storage and log paths, then review the startup plan before starting
                    it.
                  </p>
                  <p className="wg-hint">
                    The companion is this UI’s local background server. It uses the Workgraph
                    executable installed alongside it to start a daemon at this profile’s socket.
                    The daemon can keep running after you close the browser. An occupied live socket
                    is not removed.
                  </p>
                  {capabilities === null ? (
                    <p role="status">Checking paired executable…</p>
                  ) : (
                    <p className={capabilities.available ? "wg-hint" : "wg-error"}>
                      {capabilities.available
                        ? `Paired core ${capabilities.version ?? "unknown"} available`
                        : `Local startup unavailable: ${capabilities.problem?.message ?? "paired core missing"}`}{" "}
                      · <code>{capabilities.executable}</code>. Attach and reads remain available.
                    </p>
                  )}
                  <div className="wg-lifecycle-fields">
                    <Field
                      label="Registry directory on companion host"
                      hint="Where the daemon keeps its workspace directory and registry state. Choose an absolute folder path on the machine running the companion."
                      disabled={busy}
                      value={registry}
                      onChange={(event) => setRegistry(event.target.value)}
                      placeholder="/absolute/path/registry"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Field
                      label="Private startup log on companion host"
                      hint="An absolute file path for startup diagnostics. Use a private location you can inspect if startup fails or times out."
                      disabled={busy}
                      value={log}
                      onChange={(event) => setLog(event.target.value)}
                      placeholder="/absolute/path/startup.log"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Field
                      label="Startup timeout in seconds"
                      disabled={busy}
                      value={seconds}
                      onChange={(event) => setSeconds(event.target.value)}
                      inputMode="numeric"
                      hint="Wait 1–300 seconds for readiness. A timeout does not prove startup failed; inspect the saved launch before retrying."
                    />
                  </div>
                  <Button
                    disabled={busy || capabilities?.available !== true}
                    onClick={() =>
                      run(async () => {
                        const plan = createLaunch();
                        const result = await api.prepareLaunch(plan);
                        if (result.ok) {
                          recordLaunch(result.data);
                          setNotice(
                            "Saved startup plan ready for review. Start remains an explicit separate action.",
                          );
                        } else
                          setNotice(
                            `${failureText(result.failure)} The captured intention and host paths were preserved; recover this same preparation before starting.`,
                          );
                      })
                    }
                  >
                    Review startup plan
                  </Button>
                </details>
                <details className="cm-shutdown">
                  <summary>
                    <Icon name="archive" /> Stop this daemon
                  </summary>
                  <p>
                    Shutdown stops the daemon at this saved address, including one started outside
                    this UI. Other clients using it will lose access until it is started again.
                    Stored workspace data is retained.
                  </p>
                  <p className="wg-hint">
                    {writer.actorId === null
                      ? "Review shutdown will first ask you to choose an acting actor. Nothing stops until you explicitly execute the reviewed request."
                      : `The shutdown request will be attributed to ${writer.actorId}. Review first, then explicitly execute the saved request.`}
                  </p>
                  <Toolbar label="Daemon shutdown controls">
                    <Button
                      requiresActor
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          try {
                            const captured = freezeAction(
                              {
                                client,
                                connection: profile,
                                profileState: "current",
                                route,
                                writer,
                                navigate,
                              },
                              { kind: "daemon_stop" },
                              newIdentity(),
                            );
                            const result = await Promise.resolve(
                              operations.register(captured.preparation),
                            );
                            if (!result.ok) {
                              setNotice(failureText(result.failure));
                              return;
                            }
                            setStop(captured.preparation.intention_id);
                            const prepared = await operations.act(
                              captured.preparation.intention_id,
                              "prepare",
                            );
                            if (!prepared.ok) setNotice(failureText(prepared.failure));
                          } catch (error: unknown) {
                            if (error instanceof DraftInputError) setNotice(error.message);
                            else throw error;
                          }
                        })
                      }
                    >
                      Review daemon shutdown
                    </Button>
                  </Toolbar>
                </details>
              </Panel>
            )}
            {frozen !== null && hiddenPlan === frozen.intention_id && (
              <Button onClick={() => setHiddenPlan(null)}>Show captured startup plan</Button>
            )}
            {frozen !== null && hiddenPlan !== frozen.intention_id && (
              <Panel
                title="Captured startup plan"
                actions={
                  <Toolbar label="Startup review visibility">
                    <Button onClick={() => setHiddenPlan(frozen.intention_id)}>
                      Hide startup review
                    </Button>
                    <Badge
                      tone={launch?.state.status === "outcome_unknown" ? "warning" : "neutral"}
                    >
                      <span role="status" aria-live="polite" aria-atomic="true">
                        {launch === null ? "unsaved draft" : readyText(launch)}
                      </span>
                    </Badge>
                  </Toolbar>
                }
              >
                <p className="cm-explainer">
                  This review keeps the exact address, paths and author captured when you prepared
                  it. Start saved plan attempts startup; Inspect checks the recorded outcome. Hiding
                  this review does not cancel or delete it.
                </p>
                <p>
                  <code>{frozen.intention_id}</code> · {frozen.connection.label} · generation{" "}
                  {frozen.connection.generation}
                </p>
                <p>
                  Registry <code>{frozen.registry}</code>
                  <br />
                  Log <code>{frozen.log}</code>
                </p>
                <p className="wg-hint">
                  Captured actor {frozen.context.writer?.actor_id ?? "observer"}, run{" "}
                  {frozen.context.writer?.run_id ?? "none"}, workspace{" "}
                  {frozen.context.workspace_id ?? "none"}. Changing current controls does not alter
                  this plan.
                </p>
                {launch?.state.status === "outcome_unknown" && (
                  <p role="alert" className="wg-error">
                    {launch.state.problem.kind}: {launch.state.problem.message}. Inspect endpoint
                    and log before explicitly retrying this same plan.
                  </p>
                )}
                {launch?.state.status === "starting" && (
                  <ObservationNotice status={launchObservation} subject="saved startup plan" />
                )}
                {launch?.diagnostic && (
                  <p role="alert">
                    Local persistence diagnostic: {launch.diagnostic.message}. The observed endpoint
                    outcome is retained.
                  </p>
                )}
                <Toolbar label="Exact startup plan actions">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        store.stopObservingLaunch(frozen.intention_id);
                        const result = await api.prepareLaunch(frozen);
                        if (result.ok) {
                          recordLaunch(result.data);
                          setNotice("Saved exact startup plan; no startup was performed.");
                        } else
                          setNotice(
                            `${failureText(result.failure)} Preserve this intention and recover this same preparation before starting.`,
                          );
                      })
                    }
                  >
                    {launch === null ? "Save same startup plan" : "Recover same preparation"}
                  </Button>
                  <Button
                    disabled={busy || launch?.state.status !== "prepared_unsent"}
                    tone="primary"
                    onClick={() =>
                      run(async () => {
                        store.stopObservingLaunch(frozen.intention_id);
                        const result = await api.launchAction(frozen, "start");
                        if (result.ok) {
                          recordLaunch(result.data);
                        } else
                          setNotice(
                            `${failureText(result.failure)} No request was retried. Inspect saved launch before deciding what to do.`,
                          );
                      })
                    }
                  >
                    Start saved plan
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        store.stopObservingLaunch(frozen.intention_id);
                        const result = await api.inspectLaunch(frozen.intention_id, frozen);
                        if (result.ok) {
                          setFrozen(result.data.plan);
                          recordLaunch(result.data);
                        } else setNotice(failureText(result.failure));
                      })
                    }
                  >
                    Inspect saved launch
                  </Button>
                  <Button
                    disabled={busy || launch?.state.status !== "outcome_unknown"}
                    onClick={() =>
                      run(async () => {
                        store.stopObservingLaunch(frozen.intention_id);
                        const result = await api.launchAction(frozen, "retry");
                        if (result.ok) {
                          recordLaunch(result.data);
                        } else setNotice(failureText(result.failure));
                      })
                    }
                  >
                    Retry exact saved startup
                  </Button>
                </Toolbar>
                {launch?.state.status === "ready" && (
                  <p className="wg-hint">
                    Readiness is historical and ownership is unknown. Attach again to observe
                    current capabilities; selecting another endpoint never changes this launch
                    record.
                  </p>
                )}
              </Panel>
            )}
            {stop !== null && (
              <div className="cm-stop-review">
                <p className="cm-explainer">
                  Shutdown review · Executing this request stops the captured daemon. Inspect and
                  recovery controls refer to this same saved request, even if you select another
                  connection.
                </p>
                <OperationPanel
                  processing={client.processing}
                  operations={operations}
                  intention={stop}
                />
              </div>
            )}
          </section>
          <section
            hidden={section !== "launches"}
            aria-label="Startup history"
            className="cm-section"
          >
            <Panel
              title="Saved local startup attempts"
              actions={
                <>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        if (await readDirectory("0")) setDirectoryBack([]);
                      })
                    }
                  >
                    Refresh saved launches
                  </Button>
                  <Button
                    disabled={busy || directoryBack.length === 0}
                    onClick={() =>
                      run(async () => {
                        const previous = directoryBack.at(-1);
                        if (previous !== undefined && (await readDirectory(previous)))
                          setDirectoryBack((items) => items.slice(0, -1));
                      })
                    }
                  >
                    Previous page
                  </Button>
                  <Button
                    disabled={
                      busy ||
                      directory === null ||
                      !directory.ok ||
                      directory.data.next_offset === null
                    }
                    onClick={() => {
                      if (directory?.ok && directory.data.next_offset !== null)
                        run(async () => {
                          if (await readDirectory(directory.data.next_offset ?? "0"))
                            setDirectoryBack((items) => [...items, directoryOffset]);
                        });
                    }}
                  >
                    Next page
                  </Button>
                </>
              }
            >
              <p className="wg-hint">
                Saved startup plans let you inspect or recover an earlier attempt. They are not a
                list of running processes: an old ready status does not mean that daemon is still
                running. Showing records from offset {directoryOffset}.
              </p>
              {directory !== null && !directory.ok && (
                <p role="alert">{failureText(directory.failure)}</p>
              )}
              {directory?.ok && (
                <ul className="wg-lifecycle-recent">
                  {directory.data.items.map((item) => (
                    <li key={item.intention_id}>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            if (frozen !== null) store.stopObservingLaunch(frozen.intention_id);
                            const result = await api.inspectLaunch(item.intention_id);
                            if (result.ok) {
                              setFrozen(result.data.plan);
                              setHiddenPlan(null);
                              recordLaunch(result.data);
                              setSection("daemon");
                            } else setNotice(failureText(result.failure));
                          })
                        }
                      >
                        {item.connection.label} · {item.status.replaceAll("_", " ")}
                      </Button>
                      <code>{item.intention_id}</code>
                      <span>{item.registry}</span>
                    </li>
                  ))}
                </ul>
              )}
              {directory?.ok && directory.data.items.length === 0 && (
                <div className="cm-empty">
                  <Icon name="history" />
                  <h3>No saved startup attempts on this page</h3>
                  <p>
                    Plans appear here after you choose Review startup plan in Daemon. Connecting to
                    a daemon that is already running does not create a startup record.
                  </p>
                  <Button disabled={profile === undefined} onClick={() => setSection("daemon")}>
                    Go to daemon controls
                  </Button>
                </div>
              )}
            </Panel>
          </section>
          <section
            hidden={section !== "administration"}
            aria-label="Offline administration"
            className="cm-section"
          >
            {props.renderAdministration && <section>{props.renderAdministration()}</section>}
          </section>
        </div>
      </div>
    </ManagementPresentation>
  );
}
