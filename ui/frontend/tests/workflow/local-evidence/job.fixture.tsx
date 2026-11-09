/** Deterministic lifecycle rendering proof only; native journeys are separate. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LocalEvidenceFeature } from "../../../src/features/workflow/local-evidence";
import type {
  LocalEvidenceController,
  LocalEvidenceState,
  PublicationPlan,
} from "../../../src/features/workflow/local-evidence/types";
import { decode, decimal, digest, identifier, profile, rawJob } from "./fixtures";
import * as d from "../../../src/core/protocol/decoders";
import * as codecs from "../../../src/features/workflow/local-evidence/codecs";
const plan: PublicationPlan = {
  kind: "ui_prepared",
  intention_id: identifier("publish"),
  connection: profile,
  directory: "/tmp/stage",
  capture_digest: decodeDigest(),
  context: {
    workspace_id: identifier("demo"),
    project_id: null,
    writer: { actor_id: identifier("original-author"), run_id: null },
  },
  params: {
    workspace_id: identifier("demo"),
    actor_id: identifier("original-author"),
    mutation_id: identifier("publish"),
    resource_id: identifier("artifact"),
    expected_revision: decimal("0"),
    title: "Capture",
    ticket_id: identifier("task"),
  },
};
function decodeDigest() {
  return decode(d.digest, digest);
}

const publication = {
    data: {
      resource_id: "artifact",
      revision: "1",
      version: {
        revision: "1",
        digest,
        size_bytes: "500",
        actor_id: "original-author",
        timestamp: "2026-11-07T00:00:00Z",
        filename: "execution-capture.json",
        mime_type: "application/json",
      },
    },
    meta: { durable: true },
  },
  uncertain = { kind: "unknown", problem: null },
  known = { publication, link: uncertain };
function makeState(terminal: boolean): LocalEvidenceState {
  const job = decode(codecs.job, {
    ...rawJob(plan),
    state: terminal ? { kind: "published", ...known } : { kind: "running", previous: known },
  });
  return {
    directory: "",
    stage: { kind: "idle" },
    output: { kind: "idle" },
    intent: { kind: "idle" },
    saved: { kind: "idle" },
    selectedStream: "stdout",
    jobs: [job],
    diagnostic: null,
    draft: null,
    notice: null,
    busy: false,
    unexpected: null,
    observations: new Map(),
    uncertain: new Set(),
    download: { kind: "idle" },
  };
}
export function Fixture() {
  const [state, setState] = useState(() => makeState(false));
  const noAction = () => undefined;
  const done = () => Promise.resolve();
  const controller: LocalEvidenceController = {
    get: () => state,
    subscribe: () => noAction,
    setDirectory: noAction,
    inspectStage: done,
    inspectOutput: done,
    inspectIntent: done,
    newPublication: noAction,
    edit: noAction,
    review: done,
    finishSaving: done,
    associate: done,
    act: done,
    loadSaved: done,
    cleanup: done,
    download: done,
    cancelDownload: noAction,
    dispose: noAction,
  };
  return (
    <>
      <button onClick={() => setState(makeState(true))}>Complete pending link</button>
      <LocalEvidenceFeature context={null} controller={controller} />
    </>
  );
}
const mount = document.getElementById("fixture");
if (mount === null) throw new Error("Missing fixture root");
createRoot(mount).render(<Fixture />);
