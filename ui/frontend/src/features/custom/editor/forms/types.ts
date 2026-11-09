import type { ConfigDecode, ConfigIssue, RendererConfig, ViewConfig } from "../../config";
import type { JsonValue } from "../../../../core/json";

/** Parent-owned editing state, keyed by its immutable draft ID. Never an activated config. */
export interface FormDraft {
  /** Lossless candidate; edits replace only their owned paths and retain unknown fields. */
  readonly candidate: JsonValue;
  /** Incomplete numeric/scalar text, keyed by RFC6901 path. Not silently coerced. */
  readonly text: Readonly<Record<string, string>>;
  /** Local text failures supplement (never replace) foundation config validation. */
  readonly errors: readonly ConfigIssue[];
}
export interface ConfigFormProps<T extends ViewConfig | RendererConfig> {
  readonly references?: import("../ScopeChoice").ConfigurationReferences;
  /** Last valid document supplies affordances only; candidate is always the displayed source. */
  readonly value: T | null;
  readonly draft: FormDraft;
  readonly decoded: ConfigDecode | null;
  readonly disabled?: boolean;
  readonly onChange: (draft: FormDraft) => void;
  /** Explicit switch; the containing editor owns exact source and persistence. */
  readonly onRaw: () => void;
}
export type ViewFormProps = ConfigFormProps<ViewConfig>;
export type RendererFormProps = ConfigFormProps<RendererConfig>;
