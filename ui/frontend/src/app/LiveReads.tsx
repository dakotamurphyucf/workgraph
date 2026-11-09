import { LiveSlotsContext, type LiveSlots } from "../core/state/live-registry";
import { refreshSlots } from "../core/state/read-slot";
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import * as d from "../core/protocol/decoders";
import { createPortal } from "react-dom";
import type { FeatureContext } from "./types";
import type { ApplicationServices } from "../application";
import { createLiveReadOwner } from "../core/state/live-owner";
import { createLiveChangeReader } from "../core/state/live-client";
import type { LiveAdapter, LiveReadable } from "../core/state/live-types";

/** One observer for the visible feature, never one poller per card. Controllers
 * opt current projections in; retained snapshots and all write guards stay fixed. */
function adapter(
  view: FeatureContext["route"]["view"],
  pinned: boolean,
  comment: boolean,
  services: ApplicationServices,
  slots: LiveSlots,
): LiveAdapter {
  let readers: readonly LiveReadable[] = [];
  if (!pinned) {
    switch (view) {
      case "work":
        readers = [services.work, services.workProgress];
        break;
      case "workflow":
        readers = [services.work, services.workProgress, services.evidence];
        break;
      case "overview":
        readers = [services.overview];
        break;
      case "activity":
        break; // The timestamped audit feed owns its visible read slot.
      case "discussions":
        if (!comment) readers = [services.threads, services.requests];
        break;
      case "participants":
        readers = [services.participants, services.coordination];
        break;
      case "resources":
        readers = [services.resources];
        break;
      case "facts":
        readers = [services.facts];
        break;
      case "history":
        readers = [services.history, services.historyAnalytics];
        break;
      case "saved":
        readers = [services.custom];
        break;
      case "advanced":
        break; // User-submitted arbitrary reads are explicit captures.
    }
  }
  return {
    key: view,
    sources: view === "history" ? ["planning", "history"] : ["planning"],
    poll: view === "participants" || view === "overview" || view === "saved",
    async refresh(signal) {
      let ok = true,
        retainedCapture = false;
      for (const reader of readers) {
        if (signal.aborted) break;
        const result = await reader.refreshLive(signal);
        ok &&= result.ok;
        retainedCapture ||= result.retainedCapture === true;
      }
      const extra = await refreshSlots([...slots], signal);
      return {
        ok: ok && extra.ok,
        retainedCapture: retainedCapture || extra.retainedCapture === true,
      };
    },
  };
}
export function LiveReads({
  context,
  services,
  children,
}: {
  readonly context: FeatureContext;
  readonly services: ApplicationServices;
  readonly children: ReactNode;
}) {
  const owner = useMemo(
    () => createLiveReadOwner({ reader: createLiveChangeReader(services.http) }),
    [services],
  );
  const slots = useMemo<LiveSlots>(() => new Set(), []);
  const view = context.route.view,
    pinned = context.route.planning !== undefined,
    comment = context.route.discussion?.kind === "comment";
  const selected = useMemo(
    () => adapter(view, pinned, comment, services, slots),
    [services, view, pinned, comment, slots],
  );
  const { connection } = context;
  const workspaceId = context.route.workspaceId,
    projectId = context.route.projectId;
  const status = useSyncExternalStore(owner.subscribe, owner.get, owner.get);
  useEffect(() => {
    const visible = () => owner.setVisible(document.visibilityState !== "hidden");
    const wake = () => {
      if (document.visibilityState !== "hidden") owner.setVisible(true);
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    const workspace = workspaceId === null ? null : d.identifier.decode(d.jsonString(workspaceId));
    const project = projectId === null ? null : d.identifier.decode(d.jsonString(projectId));
    const close =
      workspace?.ok === false || project?.ok === false
        ? () => {}
        : owner.open(
            {
              connection,
              workspaceId: workspace?.value ?? null,
              projectId: project?.value ?? null,
            },
            selected,
          );
    return () => {
      close();
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [owner, selected, connection, workspaceId, projectId]);
  const host = document.getElementById("wg-live-status");
  const label =
    status.kind === "live"
      ? "Live"
      : status.kind === "connecting"
        ? "Connecting"
        : status.kind === "reconnecting"
          ? "Reconnecting"
          : status.kind === "offline"
            ? "Updates offline"
            : "Paused";
  return (
    <>
      <LiveSlotsContext.Provider value={slots}>{children}</LiveSlotsContext.Provider>
      {host &&
        createPortal(
          <span
            className={`wg-live-indicator wg-live-indicator--${status.kind}`}
            title={
              status.retainedCapture
                ? "Current views update automatically. Previously captured pages and historical records remain fixed."
                : "Changes appear automatically while this window is visible. Drafts and saved actions stay unchanged."
            }
          >
            <span aria-hidden="true" />
            {label}
          </span>,
          host,
        )}
    </>
  );
}
