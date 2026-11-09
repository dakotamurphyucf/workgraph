import { useEffect, useState } from "react";
import type { HttpClient } from "../../../core/protocol/http";
import { methodCodec } from "../../advanced/catalog";
import type { MethodContract } from "../../advanced/types";
export function useMethod(http: HttpClient, method: string) {
  const [state, setState] = useState<{
    method: string;
    value: MethodContract | null;
    issue: string | null;
    unexpected: { readonly error: unknown } | null;
  }>({ method, value: null, issue: null, unexpected: null });
  useEffect(() => {
    const abort = new AbortController();
    void http
      .request({
        path: `/methods/${encodeURIComponent(method)}`,
        method: "GET",
        codec: methodCodec(method),
        signal: abort.signal,
      })
      .then((result) => {
        if (abort.signal.aborted) return;
        setState(
          result.ok
            ? { method, value: result.data, issue: null, unexpected: null }
            : {
                method,
                value: null,
                issue:
                  result.failure.kind === "remote"
                    ? result.failure.problem.message
                    : "message" in result.failure
                      ? result.failure.message
                      : "Descriptor read cancelled.",
                unexpected: null,
              },
        );
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setState({ method, value: null, issue: null, unexpected: { error } });
      });
    return () => abort.abort();
  }, [http, method]);
  if (state.method === method && state.unexpected !== null) throw state.unexpected.error;
  return state.method === method ? state : { method, value: null, issue: null, unexpected: null };
}
