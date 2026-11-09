import type { FeatureContext } from "../../../app/types";
import * as d from "../../../core/protocol/decoders";
import type { Decimal, Identifier, JsonObject, Preparation } from "../../../core/protocol/types";
import type { OperationController } from "../../../core/state/operations";
import { failureText } from "../../connections/failure";
import type { ResourceCapture, ResourceRecord, ResourceScope, ResourceTarget } from "./types";
export type ResourceEditKind = "text" | "metadata" | "link" | "unlink" | "archive";
export interface ResourceEditInput {
  readonly resourceId: string;
  readonly title: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly description: string;
  readonly text: string;
  readonly changes: Readonly<{
    title: boolean;
    filename: boolean;
    mimeType: boolean;
    description: boolean;
  }>;
  readonly target: { readonly kind: ResourceTarget["kind"]; readonly id: string };
  readonly archived: boolean;
}
export interface ResourceEditDraft {
  readonly id: Identifier;
  readonly kind: ResourceEditKind;
  readonly scope: ResourceScope;
  readonly writer: { readonly actorId: Identifier; readonly runId: Identifier | null };
  readonly projectId: Identifier | null;
  readonly base: ResourceCapture<ResourceRecord> | null;
  readonly expectedRevision: Decimal;
  readonly input: ResourceEditInput;
  readonly phase: "editing" | "saving" | "registered";
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface ResourceDraftState {
  readonly drafts: readonly ResourceEditDraft[];
  readonly selectedId: Identifier | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface ResourceDraftController {
  readonly get: () => ResourceDraftState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly open: (
    context: FeatureContext,
    scope: ResourceScope,
    kind: ResourceEditKind,
    base?: ResourceCapture<ResourceRecord>,
    source?: { readonly blob: Blob; readonly version: Decimal },
  ) => Promise<void>;
  readonly edit: (id: Identifier, input: ResourceEditInput) => void;
  readonly choose: (id: Identifier | null) => void;
  readonly discard: (id: Identifier) => void;
  /** Save performs one explicitly requested prepare/execute sequence. No retry or guard refresh. */
  readonly save: (id: Identifier, execute?: boolean) => Promise<void>;
  readonly dispose: () => void;
}
export class ResourceInputError extends Error {}
const encode = new TextEncoder();
function identifier(value: string): Identifier {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok)
    throw new ResourceInputError(
      "Use an identifier of 1–96 ASCII letters, digits, underscore or hyphen.",
    );
  return result.value;
}
function decimal(value: string): Decimal {
  const result = d.decimal.decode(d.jsonString(value));
  if (!result.ok) throw new ResourceInputError("Invalid captured metadata revision.");
  return result.value;
}
function bounded(value: string, max: number, label: string) {
  if (encode.encode(value).length > max)
    throw new ResourceInputError(`${label} exceeds ${max} UTF-8 bytes.`);
  // Encoding lone surrogates would silently replace input before native admission.
  if (new TextDecoder().decode(encode.encode(value)) !== value)
    throw new ResourceInputError(`${label} contains an unpaired surrogate.`);
  return value;
}
function filename(value: string) {
  bounded(value, 255, "Filename");
  if (
    !value ||
    value === "." ||
    value === ".." ||
    [...value].some(
      (c) => c === "/" || c === "\\" || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    throw new ResourceInputError("Use a nonempty basename without slashes or control characters.");
  return value;
}
function title(value: string) {
  bounded(value, 512, "Title");
  if (!value.trim()) throw new ResourceInputError("Enter a nonempty title.");
  return value;
}
function mime(value: string) {
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?![\s\S])/u.test(value))
    throw new ResourceInputError(
      "Enter a MIME type without parameters, for example text/markdown.",
    );
  return bounded(value, 128, "MIME type");
}
export function validateResourceTextMetadata(input: {
  readonly title: string;
  readonly filename: string;
  readonly mimeType: string;
}) {
  return {
    title: title(input.title),
    filename: filename(input.filename),
    mimeType: mime(input.mimeType),
  };
}
function copyInput(input: ResourceEditInput): ResourceEditInput {
  return Object.freeze({
    ...input,
    changes: Object.freeze({ ...input.changes }),
    target: Object.freeze({ ...input.target }),
  });
}
export function resourcePreparation(draft: ResourceEditDraft): Preparation {
  const input = draft.input;
  const targetId = draft.base?.value.resource_id ?? identifier(input.resourceId);
  const fields: (readonly [string, import("../../../core/json").JsonValue])[] = [
    ["workspace_id", d.jsonString(draft.scope.workspaceId)],
    ["actor_id", d.jsonString(draft.writer.actorId)],
    ["resource_id", d.jsonString(targetId)],
    ["expected_revision", d.jsonString(draft.expectedRevision)],
    ...(draft.writer.runId === null ? [] : [["run_id", d.jsonString(draft.writer.runId)] as const]),
  ];
  let method: string;
  const add = (key: string, value: string) => fields.push([key, d.jsonString(value)]);
  switch (draft.kind) {
    case "text":
      method = "resource.put_text";
      add("text", bounded(input.text, 65536, "Document"));
      add("title", title(input.title));
      add("filename", filename(input.filename));
      add("mime_type", mime(input.mimeType));
      break;
    case "metadata":
      method = "resource.update";
      if (input.changes.title) add("title", title(input.title));
      if (input.changes.filename) add("filename", filename(input.filename));
      if (input.changes.mimeType) add("mime_type", mime(input.mimeType));
      if (input.changes.description)
        add("description", bounded(input.description, 65536, "Description"));
      if (!Object.values(input.changes).some(Boolean))
        throw new ResourceInputError("Choose at least one metadata field to replace.");
      break;
    case "link":
    case "unlink": {
      method = `resource.${draft.kind}`;
      const target: JsonObject = d.jsonObject([
        ["kind", d.jsonString(input.target.kind)],
        ...(input.target.kind === "workspace"
          ? []
          : [["id", d.jsonString(identifier(input.target.id))] as const]),
      ]);
      fields.push(["target", target]);
      break;
    }
    case "archive":
      method = "resource.archive";
      fields.push(["archived", d.jsonBoolean(input.archived)]);
      break;
  }
  return Object.freeze({
    intention_id: draft.id,
    connection_id: draft.scope.connection.id,
    generation: draft.scope.connection.generation,
    context: Object.freeze({
      workspace_id: draft.scope.workspaceId,
      project_id: draft.projectId,
      writer: Object.freeze({ actor_id: draft.writer.actorId, run_id: draft.writer.runId }),
    }),
    method,
    params: d.jsonObject(fields),
  });
}
export function createResourceDraftController(
  operations: OperationController,
): ResourceDraftController {
  let state: ResourceDraftState = Object.freeze({
    drafts: [],
    selectedId: null,
    issue: null,
    unexpected: null,
  });
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (change: Partial<ResourceDraftState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...change });
    listeners.forEach((f) => f());
  };
  const get = (id: Identifier) => state.drafts.find((d) => d.id === id);
  const update = (id: Identifier, change: Partial<ResourceEditDraft>) =>
    publish({
      drafts: state.drafts.map((d) => (d.id === id ? Object.freeze({ ...d, ...change }) : d)),
    });
  const room = (input: ResourceEditInput, except?: Identifier) => {
    const size = (value: ResourceEditInput) =>
      encode.encode(value.text).length +
      encode.encode(value.description).length +
      encode.encode(value.title).length +
      encode.encode(value.filename).length +
      encode.encode(value.mimeType).length;
    if (
      state.drafts.filter((d) => d.id !== except).reduce((n, d) => n + size(d.input), size(input)) >
      2 * 1024 * 1024
    )
      throw new ResourceInputError(
        "Retained resource editors exceed 2MiB. Close an editor before retaining more source.",
      );
  };
  async function open(
    context: FeatureContext,
    scope: ResourceScope,
    kind: ResourceEditKind,
    base?: ResourceCapture<ResourceRecord>,
    source?: { readonly blob: Blob; readonly version: Decimal },
  ) {
    // Capture all attribution before any Blob read. Selection and acting actor
    // changes during the await cannot silently alter this new draft.
    try {
      if (state.drafts.length >= 24)
        throw new ResourceInputError(
          "Close a resource editor before opening another (24 maximum).",
        );
      if (
        context.profileState !== "current" ||
        context.connection.id !== scope.connection.id ||
        context.connection.generation !== scope.connection.generation ||
        context.connection.socket !== scope.connection.socket ||
        context.route.workspaceId !== scope.workspaceId
      )
        throw new ResourceInputError(
          "New edits require the current matching connection/workspace. Retained old operations remain inspectable.",
        );
      if (context.writer.actorId === null)
        throw new ResourceInputError("Choose the actual acting actor before editing.");
      if (base?.partial)
        throw new ResourceInputError("Refresh complete metadata before opening a guarded editor.");
      if (
        base &&
        (base.scope.connection.id !== scope.connection.id ||
          base.scope.connection.generation !== scope.connection.generation ||
          base.scope.connection.socket !== scope.connection.socket ||
          base.scope.workspaceId !== scope.workspaceId)
      )
        throw new ResourceInputError("Metadata belongs to another captured resource scope.");
      if (kind !== "text" && !base)
        throw new ResourceInputError("Select a resource before editing metadata or associations.");
      const frozenScope = Object.freeze({
          ...scope,
          connection: Object.freeze({ ...scope.connection }),
        }),
        writer = Object.freeze({
          actorId: identifier(context.writer.actorId),
          runId: context.writer.runId === null ? null : identifier(context.writer.runId),
        }),
        projectId = context.route.projectId === null ? null : identifier(context.route.projectId);
      const id = identifier(`resource-${crypto.randomUUID()}`);
      let text = "";
      if (source) {
        if (source.blob.size > 65536)
          throw new ResourceInputError(
            "Text editing supports complete UTF-8 documents up to 64KiB. Use binary replacement for larger or binary content.",
          );
        const bytes = await source.blob.arrayBuffer();
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (error) {
          if (error instanceof TypeError)
            throw new ResourceInputError(
              "This publication is not UTF-8 text. Use binary replacement.",
            );
          throw error;
        }
      }
      const metadata = base?.value.metadata;
      const input = copyInput({
        resourceId: base?.value.resource_id ?? "",
        title: metadata?.title ?? "",
        filename: metadata?.filename ?? "document.md",
        mimeType: metadata?.mime_type ?? "text/markdown",
        description: metadata?.description ?? "",
        text,
        changes: { title: false, filename: false, mimeType: false, description: false },
        target: { kind: "project", id: projectId ?? "" },
        archived: !(metadata?.archived ?? false),
      });
      if (disposed) return;
      if (state.drafts.length >= 24)
        throw new ResourceInputError("Resource editor capacity filled while reading content.");
      room(input);
      const draft: ResourceEditDraft = Object.freeze({
        id,
        kind,
        scope: frozenScope,
        writer,
        projectId,
        base: base ?? null,
        expectedRevision: base?.value.revision ?? decimal("0"),
        input,
        phase: "editing",
        issue: source
          ? `Source publication ${source.version}; saving creates a new guarded publication.`
          : null,
        unexpected: null,
      });
      publish({ drafts: [...state.drafts, draft], selectedId: id, issue: null });
    } catch (error) {
      if (error instanceof ResourceInputError) publish({ issue: error.message });
      else publish({ unexpected: { error } });
    }
  }
  async function save(id: Identifier, execute = true) {
    const draft = get(id);
    if (!draft || draft.phase !== "editing") return;
    try {
      const preparation = resourcePreparation(draft);
      update(id, { phase: "saving", issue: null });
      const registered = await operations.register(preparation);
      if (!registered.ok) {
        update(id, {
          phase: operations.get(id) ? "registered" : "editing",
          issue: failureText(registered.failure),
        });
        return;
      }
      update(id, { phase: "registered" });
      if (!execute) return;
      const prepared = await operations.act(id, "prepare");
      if (!prepared.ok) {
        update(id, { issue: failureText(prepared.failure) });
        return;
      }
      if (prepared.entry.operation?.state.kind !== "prepared_unsent") return;
      const executed = await operations.act(id, "execute");
      if (!executed.ok) update(id, { issue: failureText(executed.failure) });
    } catch (error) {
      if (error instanceof ResourceInputError) update(id, { issue: error.message });
      else
        update(id, { phase: operations.get(id) ? "registered" : "editing", unexpected: { error } });
    }
  }
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open,
    edit: (id, input) => {
      const draft = get(id);
      if (!draft || draft.phase !== "editing") return;
      try {
        const copied = copyInput(input);
        room(copied, id);
        update(id, { input: copied, issue: null });
      } catch (error) {
        if (error instanceof ResourceInputError) update(id, { issue: error.message });
        else update(id, { unexpected: { error } });
      }
    },
    choose: (id) => publish({ selectedId: id }),
    discard: (id) => {
      const draft = get(id);
      if (!draft || draft.phase === "saving") return;
      publish({
        drafts: state.drafts.filter((d) => d.id !== id),
        selectedId: state.selectedId === id ? null : state.selectedId,
      });
    },
    save,
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
  };
}
