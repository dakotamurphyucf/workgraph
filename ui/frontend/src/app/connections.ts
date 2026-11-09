import { useEffect, useState } from "react";
import { pinDefaultProfile } from "./connectionSelection";
import { array, record } from "../core/protocol/codec";
import { connectionProfile } from "../core/protocol/decoders";
import type { HttpClient, HttpFailure } from "../core/protocol/http";
import type { ConnectionProfile } from "../core/protocol/types";

export const connectionDirectoryCodec = record({ items: array(connectionProfile, 100) });
export type ConnectionDirectory =
  | { readonly kind: "loading"; readonly items: readonly ConnectionProfile[] | null }
  | { readonly kind: "ready"; readonly items: readonly ConnectionProfile[] }
  | {
      readonly kind: "failed";
      readonly items: readonly ConnectionProfile[] | null;
      readonly failure: HttpFailure;
    }
  | { readonly kind: "crashed"; readonly error: unknown };
interface CapturedDirectory {
  readonly client: HttpClient;
  readonly epoch: number;
  readonly defaultConnectionId: string | null;
  readonly value: ConnectionDirectory;
}
function retainedItems(captured: CapturedDirectory | null, client: HttpClient) {
  return captured?.client === client && captured.value.kind !== "crashed"
    ? captured.value.items
    : null;
}
/** Refresh the host registry on opening, visibility, connectivity and explicit
 * changes. Idle tabs do not poll it. Failed checks retry with bounded backoff. */
export function useConnections(client: HttpClient): {
  readonly directory: ConnectionDirectory;
  readonly defaultConnectionId: string | null;
  readonly refresh: () => void;
} {
  const [epoch, setEpoch] = useState(0);
  const [captured, setCaptured] = useState<CapturedDirectory | null>(null);
  useEffect(() => {
    let active = true,
      flight: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const visible = () => document.visibilityState !== "hidden";
    const stop = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      flight?.abort();
      flight = null;
    };
    const read = async () => {
      if (!active || !visible() || flight !== null) return;
      const abort = new AbortController();
      flight = abort;
      try {
        const result = await client.request({
          path: "/connections",
          method: "GET",
          codec: connectionDirectoryCodec,
          signal: abort.signal,
        });
        if (!active || abort.signal.aborted) return;
        failures = result.ok ? 0 : failures + 1;
        setCaptured((previous) => {
          const old = retainedItems(previous, client);
          const items =
            result.ok &&
            old &&
            old.length === result.data.items.length &&
            old.every((item, index) => {
              const next = result.data.items[index];
              return (
                next &&
                item.id === next.id &&
                item.generation === next.generation &&
                item.socket === next.socket &&
                item.label === next.label
              );
            })
              ? old
              : result.ok
                ? result.data.items
                : old;
          return {
            client,
            epoch,
            defaultConnectionId: pinDefaultProfile(
              previous?.client === client ? previous.defaultConnectionId : null,
              result.ok ? result.data.items : [],
            ),
            value: result.ok
              ? { kind: "ready", items: items ?? [] }
              : { kind: "failed", items, failure: result.failure },
          };
        });
      } catch (error: unknown) {
        if (active && !abort.signal.aborted)
          setCaptured({
            client,
            epoch,
            defaultConnectionId: null,
            value: { kind: "crashed", error },
          });
      } finally {
        if (flight === abort) flight = null;
        if (active && !abort.signal.aborted && visible() && failures > 0)
          timer = setTimeout(
            () => {
              void read();
            },
            Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)),
          );
      }
    };
    const wake = () => {
      stop();
      if (visible()) void read();
    };
    void read();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      active = false;
      stop();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [client, epoch]);
  return {
    defaultConnectionId: captured?.client === client ? captured.defaultConnectionId : null,
    directory:
      captured?.client === client && captured.epoch === epoch
        ? captured.value
        : { kind: "loading", items: retainedItems(captured, client) },
    refresh: () => {
      setEpoch((value) => value + 1);
    },
  };
}
export function failureMessage(failure: HttpFailure): string {
  switch (failure.kind) {
    case "input":
    case "network":
    case "protocol":
      return failure.message;
    case "remote":
      return failure.problem.message;
    case "aborted":
      return "The connection check was canceled. No data was loaded.";
  }
}
