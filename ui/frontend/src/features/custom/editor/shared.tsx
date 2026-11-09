import type { HttpClient, HttpFailure, HttpResult } from "../../../core/protocol/http";
import type { Identifier } from "../../../core/protocol/types";
import { createResourcesClient } from "../../knowledge/resources/client";
import { createFactsClient } from "../../knowledge/facts/client";
import { decodeConfigValue } from "../config/decode";
import {
  ConfigInputError,
  createConfigStore,
  publicationBase,
  prepareConfigPublication,
  readCatalogEntry,
  samePin,
  type ConfigPublicationCapture,
  type ConfigScope,
  type ContentPin,
  type PublicationBase,
  type RegisteredRenderer,
  type RendererConfig,
  type VerifiedConfig,
  type ViewConfig,
} from "../config";
import { counter } from "./model";
import type { CustomTarget, SharedCatalog } from "./types";
export class SharedReadError extends Error {
  constructor(readonly failure: HttpFailure) {
    super(
      failure.kind === "remote"
        ? failure.problem.message
        : "message" in failure
          ? failure.message
          : "Read cancelled.",
    );
  }
}
const requireRead = <T,>(result: HttpResult<T>): T => {
  if (!result.ok) throw new SharedReadError(result.failure);
  return result.data;
};
function configFailure(kind: string, message: string): Extract<HttpResult<never>, { ok: false }> {
  return {
    ok: false,
    failure: {
      kind: kind === "cancelled" ? "aborted" : "protocol",
      message: `[${kind}] ${message}`,
      issue: undefined,
    },
  };
}
export function createSharedConfiguration(http: HttpClient) {
  const resources = createResourcesClient(http),
    facts = createFactsClient(http),
    store = createConfigStore({ http });
  async function index(target: CustomTarget, scope: ConfigScope, signal: AbortSignal) {
    const result = requireRead(
      await facts.multiGet({ ...target, scope }, ["ui.config.index"], {}, signal),
    );
    if (result.partial || result.value.items.length !== 1)
      throw new ConfigInputError(
        "Shared index observation is incomplete; no absence or revision0 was inferred.",
      );
    const found = result.value.items[0];
    if (found === undefined) throw new ConfigInputError("Shared index observation is missing.");
    if (found.kind === "missing") return { revision: counter("0"), pin: null };
    if (found.kind === "deleted") return { revision: found.revision, pin: null };
    const decoded = decodeConfigValue(found.value);
    if (decoded.kind !== "valid" || "kind" in decoded.document)
      throw new ConfigInputError(
        "Shared index source is invalid or unsupported. Inspect its exact fact value before replacing it.",
      );
    return { revision: found.revision, pin: decoded.document.catalog };
  }
  async function verified(
    target: CustomTarget,
    pin: ContentPin,
    signal: AbortSignal,
  ): Promise<VerifiedConfig> {
    const result = await store.read(target, pin, signal);
    if (!result.ok) throw new SharedReadError(configFailure(result.kind, result.message).failure);
    return result.capture;
  }
  async function base(
    target: CustomTarget,
    resourceId: Identifier,
    link: ConfigPublicationCapture["link"],
    signal: AbortSignal,
  ): Promise<PublicationBase> {
    const result = await resources.get(target, resourceId, signal);
    if (
      !result.ok &&
      result.failure.kind === "remote" &&
      result.failure.problem.kind === "Not_found"
    )
      return { kind: "missing" };
    return publicationBase(requireRead(result), link);
  }
  return {
    async load(
      target: CustomTarget,
      scope: ConfigScope,
      signal: AbortSignal,
    ): Promise<HttpResult<SharedCatalog>> {
      try {
        const observed = await index(target, scope, signal);
        if (observed.pin === null)
          return {
            ok: false,
            failure: {
              kind: "remote",
              problem: {
                kind: "Not_found",
                message: "No shared catalog is registered at this explicit fact scope.",
                details: undefined,
              },
              httpStatus: 404,
            },
          };
        const capture = await verified(target, observed.pin, signal);
        if (
          capture.decoded.kind !== "valid" ||
          !("kind" in capture.decoded.document) ||
          capture.decoded.document.kind !== "catalog"
        )
          throw new ConfigInputError(
            "The shared catalog pin resolves to invalid or unsupported catalog source.",
          );
        const renderers: RegisteredRenderer[] = [],
          unavailable: { pin: ContentPin; message: string }[] = [];
        for (const entry of capture.decoded.document.entries) {
          if (entry.kind !== "renderer") continue;
          const result = await readCatalogEntry(store, target, entry, signal);
          if (!result.ok) {
            unavailable.push({ pin: entry.pin, message: `[${result.kind}] ${result.message}` });
            continue;
          }
          const decoded = result.capture.decoded;
          if (
            decoded.kind !== "valid" ||
            !("kind" in decoded.document) ||
            decoded.document.kind !== "renderer"
          )
            unavailable.push({
              pin: entry.pin,
              message: "Renderer source is invalid or unsupported; its immutable pin is retained.",
            });
          else renderers.push({ pin: entry.pin, renderer: decoded.document });
        }
        if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
        return {
          ok: true,
          httpStatus: 200,
          data: { scope, indexRevision: observed.revision, capture, renderers, unavailable },
        };
      } catch (error) {
        if (error instanceof SharedReadError) return { ok: false, failure: error.failure };
        if (error instanceof ConfigInputError)
          return { ok: false, failure: { kind: "input", message: error.message } };
        throw error;
      }
    },
    async open(catalog: SharedCatalog, id: Identifier, signal: AbortSignal) {
      const decoded = catalog.capture.decoded;
      if (
        decoded.kind !== "valid" ||
        !("kind" in decoded.document) ||
        decoded.document.kind !== "catalog"
      )
        throw new ConfigInputError("Inspect a valid exact catalog before opening an entry.");
      const entry = decoded.document.entries.find((entry) => entry.id === id);
      if (entry === undefined)
        throw new ConfigInputError("The exact catalog does not contain this document ID.");
      return readCatalogEntry(store, catalog.capture.scope, entry, signal);
    },
    async prepare(
      target: CustomTarget,
      document: ViewConfig | RendererConfig,
      intentionId: Identifier,
      writer: ConfigPublicationCapture["writer"],
      input: {
        readonly documentResourceId: Identifier;
        readonly catalogResourceId: Identifier;
        readonly indexScope: ConfigScope;
        readonly link: ConfigPublicationCapture["link"];
      },
      signal: AbortSignal,
    ) {
      const observed = await index(target, input.indexScope, signal);
      if (observed.pin !== null && observed.pin.resource_id !== input.catalogResourceId)
        throw new ConfigInputError(
          `This scope already indexes catalog ${observed.pin.resource_id}. Use that exact catalog ID to preserve its entries.`,
        );
      const documentBase = await base(target, input.documentResourceId, input.link, signal),
        catalogBase = await base(target, input.catalogResourceId, input.link, signal);
      let catalog: ConfigPublicationCapture["catalog"] = { kind: "new" };
      if (catalogBase.kind === "existing") {
        if (observed.pin !== null && !samePin(observed.pin, catalogBase.content))
          throw new ConfigInputError(
            "The indexed catalog and current resource content differ. No old catalog was silently replaced.",
          );
        catalog = {
          kind: "existing",
          capture: await verified(target, catalogBase.content, signal),
        };
      } else if (observed.pin !== null)
        throw new ConfigInputError(
          "The indexed catalog resource is missing. Preserve its pin and repair explicitly.",
        );
      return prepareConfigPublication(
        http.processing,
        {
          intentionId,
          documentResourceId: input.documentResourceId,
          catalogResourceId: input.catalogResourceId,
          document,
          capture: {
            connection: target.connection,
            workspaceId: target.workspaceId,
            writer,
            link: input.link,
            index: { scope: input.indexScope, expectedRevision: observed.revision },
            documentBase,
            catalogBase,
            catalog,
          },
        },
        signal,
      );
    },
    dispose: store.dispose,
  };
}
