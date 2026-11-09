import type { JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { Decimal, JsonObject } from "../../../core/protocol/types";
import type { ProcessingFailure, ProtocolProcessor } from "../../../core/protocol/worker";
import { CONFIG_LIMITS, decodeConfigValue, decodeConfigSource } from "./decode";
import { scopeCodec, pinCodec } from "./codecs";
import { configJson, pinJson, scopeJson } from "./encode";
import type {
  CatalogConfig,
  ConfigPublicationIntention,
  ConfigPublicationCapture,
  ContentPin,
  PreparedConfigPublication,
  PublicationBase,
} from "./types";
export class ConfigInputError extends Error {}
/** Expected worker lifetime/capacity outcome; never an invalid-document diagnosis. */
export class ConfigProcessingError extends Error {
  readonly kind: ProcessingFailure["kind"];
  constructor(failure: ProcessingFailure) {
    super(failure.message);
    this.kind = failure.kind;
  }
}
const checkedDecimal = (value: string): Decimal => {
  const r = d.decimal.decode(d.jsonString(value));
  if (!r.ok)
    throw new ConfigInputError(
      "Captured revision or content version is outside the daemon domain.",
    );
  return r.value;
};
const next = (value: Decimal) => checkedDecimal(String(BigInt(value) + 1n));
const zero = checkedDecimal("0");
function expected(base: PublicationBase, id: string, capture: ConfigPublicationCapture): Decimal {
  if (base.kind === "missing") return zero;
  if (
    base.scope.workspaceId !== capture.workspaceId ||
    base.scope.connection.id !== capture.connection.id ||
    base.scope.connection.generation !== capture.connection.generation ||
    base.scope.connection.socket !== capture.connection.socket ||
    base.link.kind !== capture.link.kind ||
    (base.link.kind === "project" &&
      (capture.link.kind !== "project" || base.link.id !== capture.link.id))
  )
    throw new ConfigInputError(
      "Resource base provenance must match the captured endpoint generation, workspace and exact link target.",
    );
  const count = checkedDecimal(base.versionCount),
    metadata = checkedDecimal(base.metadataRevision);
  if (!pinCodec.decode(pinJson(base.content)).ok)
    throw new ConfigInputError("Invalid captured resource content pin.");
  if (
    base.resourceId !== id ||
    base.content.resource_id !== id ||
    base.content.version !== count ||
    count === "0" ||
    BigInt(metadata) < BigInt(count)
  )
    throw new ConfigInputError(
      "Resource base must retain its exact ID, complete version count, latest content and independent metadata guard.",
    );
  next(count);
  next(metadata);
  return metadata;
}
const operation = (method: string, params: JsonObject) =>
  d.jsonObject([
    ["method", d.jsonString(method)],
    ["params", params],
  ]);
/** Pure preparation only. Caller explicitly registers/prepares/applies with the shared operation owner. */
export async function prepareConfigPublication(
  processing: ProtocolProcessor,
  intention: ConfigPublicationIntention,
  signal?: AbortSignal,
): Promise<PreparedConfigPublication> {
  // Copy attribution, targets and guards before suspension; serialization captures literal scalar ownership synchronously.
  const capture = intention.capture;
  const retained = Object.freeze({
    ...intention,
    capture: Object.freeze({
      ...capture,
      connection: Object.freeze({ ...capture.connection }),
      writer: Object.freeze({ ...capture.writer }),
      link: Object.freeze({ ...capture.link }),
      index: Object.freeze({ ...capture.index, scope: Object.freeze({ ...capture.index.scope }) }),
      documentBase: Object.freeze(
        capture.documentBase.kind === "missing"
          ? { kind: "missing" as const }
          : {
              ...capture.documentBase,
              content: Object.freeze({ ...capture.documentBase.content }),
              scope: Object.freeze({
                ...capture.documentBase.scope,
                connection: Object.freeze({ ...capture.documentBase.scope.connection }),
              }),
              link: Object.freeze({ ...capture.documentBase.link }),
            },
      ),
      catalogBase: Object.freeze(
        capture.catalogBase.kind === "missing"
          ? { kind: "missing" as const }
          : {
              ...capture.catalogBase,
              content: Object.freeze({ ...capture.catalogBase.content }),
              scope: Object.freeze({
                ...capture.catalogBase.scope,
                connection: Object.freeze({ ...capture.catalogBase.scope.connection }),
              }),
              link: Object.freeze({ ...capture.catalogBase.link }),
            },
      ),
    }),
  });
  for (const id of [
    retained.intentionId,
    retained.documentResourceId,
    retained.catalogResourceId,
    capture.workspaceId,
    capture.connection.id,
    capture.writer.actorId,
    ...(capture.writer.runId === null ? [] : [capture.writer.runId]),
  ])
    if (!d.identifier.decode(d.jsonString(id)).ok)
      throw new ConfigInputError("Publication requires exact validated identities.");
  checkedDecimal(retained.capture.connection.generation);
  next(checkedDecimal(retained.capture.index.expectedRevision));
  if (
    !scopeCodec.decode(scopeJson(retained.capture.index.scope)).ok ||
    (retained.capture.link.kind !== "workspace" && retained.capture.link.kind !== "project") ||
    !scopeCodec.decode(scopeJson(retained.capture.link)).ok
  )
    throw new ConfigInputError(
      "Choose a valid explicit index scope and a separate workspace/project resource link.",
    );

  if (retained.documentResourceId === retained.catalogResourceId)
    throw new ConfigInputError("Configuration and catalog resources must have distinct IDs.");
  const documentGuard = expected(
      retained.capture.documentBase,
      retained.documentResourceId,
      retained.capture,
    ),
    catalogGuard = expected(
      retained.capture.catalogBase,
      retained.catalogResourceId,
      retained.capture,
    );
  if (retained.capture.documentBase.kind === "missing" || !retained.capture.documentBase.linked)
    next(next(documentGuard));
  if (retained.capture.catalogBase.kind === "missing" || !retained.capture.catalogBase.linked)
    next(next(catalogGuard));
  const documentVersion =
    retained.capture.documentBase.kind === "missing"
      ? next(zero)
      : next(retained.capture.documentBase.versionCount);
  const catalogVersion =
    retained.capture.catalogBase.kind === "missing"
      ? next(zero)
      : next(retained.capture.catalogBase.versionCount);
  const rawDocument = configJson(intention.document);
  const decodedDocument = decodeConfigValue(rawDocument);
  if (
    decodedDocument.kind !== "valid" ||
    !("kind" in decodedDocument.document) ||
    (decodedDocument.document.kind !== "view" && decodedDocument.document.kind !== "renderer")
  )
    throw new ConfigInputError("Repair the configuration before publishing.");
  const catalogInput =
    capture.catalog.kind === "new"
      ? Object.freeze({ kind: "new" as const })
      : Object.freeze({
          kind: "existing" as const,
          capture: Object.freeze({
            ...capture.catalog.capture,
            pin: Object.freeze({ ...capture.catalog.capture.pin }),
            scope: Object.freeze({
              ...capture.catalog.capture.scope,
              connection: Object.freeze({ ...capture.catalog.capture.scope.connection }),
            }),
          }),
        });
  if (
    retained.capture.catalogBase.kind === "missing"
      ? catalogInput.kind !== "new"
      : catalogInput.kind !== "existing"
  )
    throw new ConfigInputError(
      "Existing catalog guards require their verified source; a missing catalog starts empty.",
    );
  const emptyCatalog: CatalogConfig = { config_version: 1, kind: "catalog", entries: [] };
  async function encoded(value: JsonValue): Promise<string> {
    const result = await processing.encode(value, {
      canonical: true,
      limits: CONFIG_LIMITS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.ok) throw new ConfigProcessingError(result.failure);
    if (!result.value.ok) throw new ConfigInputError(result.value.error.message);
    return result.value.value;
  }
  // Encoding captures mutable literal nodes before this first await. All source associations were copied above.
  const documentText = await encoded(rawDocument);
  let retainedCatalog = catalogInput;
  let catalogDocument: CatalogConfig = emptyCatalog;
  if (catalogInput.kind === "existing") {
    const source = catalogInput.capture;
    const base = retained.capture.catalogBase;
    if (
      base.kind !== "existing" ||
      source.scope.workspaceId !== retained.capture.workspaceId ||
      source.scope.connection.id !== retained.capture.connection.id ||
      source.scope.connection.generation !== retained.capture.connection.generation ||
      source.scope.connection.socket !== retained.capture.connection.socket ||
      source.pin.resource_id !== retained.catalogResourceId ||
      source.pin.version !== base.content.version ||
      source.pin.digest !== base.content.digest ||
      source.pin.size_bytes !== base.content.size_bytes ||
      source.blob.size > CONFIG_LIMITS.maxBytes ||
      String(source.blob.size) !== source.pin.size_bytes
    )
      throw new ConfigInputError(
        "Catalog source must match the captured endpoint, workspace and guarded immutable content pin.",
      );
    const bytes = new Uint8Array(await source.blob.arrayBuffer());
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== source.pin.digest)
      throw new ConfigInputError("Catalog source SHA-256 differs from its retained content pin.");
    const decoded = await decodeConfigSource(processing, bytes, signal);
    if (!decoded.ok) throw new ConfigProcessingError(decoded.failure);
    if (
      decoded.value.kind !== "valid" ||
      !("kind" in decoded.value.document) ||
      decoded.value.document.kind !== "catalog"
    )
      throw new ConfigInputError("Repair the exact catalog source before replacing it.");
    catalogDocument = decoded.value.document;
    retainedCatalog = Object.freeze({
      kind: "existing",
      capture: Object.freeze({ ...source, decoded: decoded.value }),
    });
  }
  async function pin(
    resource_id: ContentPin["resource_id"],
    version: Decimal,
    text: string,
  ): Promise<ContentPin> {
    const bytes = new TextEncoder().encode(text);
    const digestText = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const digest = d.digest.decode(d.jsonString(digestText));
    if (!digest.ok) throw new Error("SHA-256 returned an invalid digest.");
    return Object.freeze({
      resource_id,
      version,
      digest: digest.value,
      size_bytes: checkedDecimal(String(bytes.byteLength)),
    });
  }
  const documentParse = await processing.parse(documentText, {
    limits: CONFIG_LIMITS,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!documentParse.ok) throw new ConfigProcessingError(documentParse.failure);
  if (!documentParse.value.ok) throw new ConfigInputError(documentParse.value.error.message);
  const safeDocument = decodeConfigValue(documentParse.value.value.value);
  if (
    safeDocument.kind !== "valid" ||
    !("kind" in safeDocument.document) ||
    (safeDocument.document.kind !== "view" && safeDocument.document.kind !== "renderer")
  )
    throw new ConfigInputError("Captured document could not be retained.");
  const document = safeDocument.document;
  const documentPin = await pin(retained.documentResourceId, documentVersion, documentText);
  const catalog: CatalogConfig = Object.freeze({
    config_version: 1,
    kind: "catalog",
    entries: Object.freeze([
      ...catalogDocument.entries.filter((entry) => entry.id !== document.id),
      Object.freeze({
        kind: document.kind,
        id: document.id,
        pin: documentPin,
      }),
    ]),
  });
  if (decodeConfigValue(configJson(catalog)).kind !== "valid")
    throw new ConfigInputError("Updated catalog exceeds its entry or identity bounds.");
  const catalogText = await encoded(configJson(catalog));
  const catalogPin = await pin(retained.catalogResourceId, catalogVersion, catalogText);
  const put = (id: string, guard: Decimal, text: string, title: string) =>
    operation(
      "resource.put_text",
      d.jsonObject([
        ["resource_id", d.jsonString(id)],
        ["expected_revision", d.jsonString(guard)],
        ["title", d.jsonString(title)],
        ["text", d.jsonString(text)],
        ["filename", d.jsonString(`${id}.json`)],
        ["mime_type", d.jsonString("application/json")],
      ]),
    );
  const link = (id: string, guard: Decimal) =>
    operation(
      "resource.link",
      d.jsonObject([
        ["resource_id", d.jsonString(id)],
        ["expected_revision", d.jsonString(next(guard))],
        ["target", scopeJson(retained.capture.link)],
      ]),
    );
  const operations = [
    put(retained.documentResourceId, documentGuard, documentText, document.title),
    ...(retained.capture.documentBase.kind === "existing" && retained.capture.documentBase.linked
      ? []
      : [link(retained.documentResourceId, documentGuard)]),
    put(retained.catalogResourceId, catalogGuard, catalogText, "Configuration catalog"),
    ...(retained.capture.catalogBase.kind === "existing" && retained.capture.catalogBase.linked
      ? []
      : [link(retained.catalogResourceId, catalogGuard)]),
    operation(
      "fact.put",
      d.jsonObject([
        ["scope", scopeJson(retained.capture.index.scope)],
        ["key", d.jsonString("ui.config.index")],
        ["expected_revision", d.jsonString(retained.capture.index.expectedRevision)],
        [
          "value",
          d.jsonObject([
            ["config_version", d.jsonNumber("1")],
            ["catalog", pinJson(catalogPin)],
          ]),
        ],
      ]),
    ),
  ];
  if (signal?.aborted)
    throw new ConfigProcessingError({
      kind: "aborted",
      message: "Config preparation was cancelled.",
    });
  return Object.freeze({
    intention: Object.freeze({
      ...retained,
      document,
      capture: Object.freeze({ ...retained.capture, catalog: retainedCatalog }),
    }),
    documentPin,
    catalogPin,
    preparation: Object.freeze({
      intention_id: retained.intentionId,
      connection_id: retained.capture.connection.id,
      generation: retained.capture.connection.generation,
      context: Object.freeze({
        workspace_id: retained.capture.workspaceId,
        project_id: retained.capture.link.kind === "project" ? retained.capture.link.id : null,
        writer: Object.freeze({
          actor_id: retained.capture.writer.actorId,
          run_id: retained.capture.writer.runId,
        }),
      }),
      method: "transaction.apply",
      params: d.jsonObject([
        ["workspace_id", d.jsonString(retained.capture.workspaceId)],
        ["actor_id", d.jsonString(retained.capture.writer.actorId)],
        ["mutation_id", d.jsonString(retained.intentionId)],
        ...(retained.capture.writer.runId === null
          ? []
          : [["run_id", d.jsonString(retained.capture.writer.runId)] as const]),
        ["operations", d.jsonArray(operations)],
      ]),
    }),
  });
}
