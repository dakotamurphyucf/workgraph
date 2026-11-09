import type { ReactNode } from "react";
import type { JsonValue } from "../../../../core/json";
import type { ProtocolProcessor } from "../../../../core/protocol/worker/types";
import type { Identifier } from "../../../../core/protocol/types";
import type { ContentPin, LoadedRow, RendererConfig, ViewConfig } from "../../config";

/** Caller-provided capture labels retain domain-specific revisions/heads without conflation. */
export interface RowsCoverage {
  readonly capture: readonly { readonly label: string; readonly value: string }[];
  readonly complete: boolean;
  readonly partial: boolean;
  readonly byteCoverage?:
    | { readonly kind: "reported"; readonly truncated: boolean }
    | { readonly kind: "not_reported"; readonly message: string };
  readonly stop: string;
  /** Optional value acquisition is independent of collection/metadata coverage. */
  readonly values?: readonly {
    readonly identity: string;
    readonly status:
      "decoded" | "missing" | "deleted" | "unsupported" | "budget" | "invalid" | "unavailable";
    readonly message: string | null;
    readonly pin: ContentPin | null;
  }[];
}
export type CellReference =
  | { readonly kind: "resource_pin"; readonly pin: ContentPin }
  | { readonly kind: "entity"; readonly entity: "workspace" }
  | {
      readonly kind: "entity";
      readonly entity: "project" | "milestone" | "ticket" | "resource";
      readonly id: Identifier;
    };
/** The caller binds these callbacks to the exact page endpoint, never current global selection. */
export interface PresentationNavigation {
  readonly canOpenRow?: (row: LoadedRow) => boolean;
  readonly onOpenRow?: (row: LoadedRow) => void;
  readonly canOpenReference?: (reference: CellReference) => boolean;
  readonly onOpenReference?: (reference: CellReference) => void;
}
export interface RowsPresentationProps extends PresentationNavigation {
  /** Exact endpoint + config/collection capture; used to own local position and cell views. */
  readonly identity: string;
  readonly view: ViewConfig;
  /** Exact captured adapter rows. This component does no I/O or continuation. */
  readonly rows: readonly LoadedRow[];
  readonly coverage: RowsCoverage;
  readonly processing: ProtocolProcessor;
}
export interface ValuePresentationProps extends PresentationNavigation {
  /** Exact endpoint + entity/content version/capture. Never just a renderer/config ID. */
  readonly identity: string;
  readonly value: JsonValue;
  readonly renderer: RendererConfig;
  readonly generic: ReactNode;
  readonly processing: ProtocolProcessor;
}
