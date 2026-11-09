import { useActorAccess } from "./ActorAccess";
import { useId } from "react";
import type { ButtonProps, FieldProps, SelectProps, StatePanelProps } from "./types";

export function Button({
  tone = "default",
  className = "",
  type = "button",
  requiresActor = false,
  onClick,
  ...props
}: ButtonProps) {
  const access = useActorAccess();
  return (
    <button
      {...props}
      type={type}
      className={`wg-button wg-button--${tone} ${className}`}
      onClick={(event) => {
        if (requiresActor && access?.actorId === null) {
          event.preventDefault();
          access.choose();
          return;
        }
        onClick?.(event);
      }}
    />
  );
}
export function Field({ label, hint, error, id: supplied, ...props }: FieldProps) {
  const generated = useId();
  const id = supplied ?? generated;
  const described =
    [hint ? `${id}-hint` : "", error ? `${id}-error` : "", props["aria-describedby"] ?? ""]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="wg-field">
      <label htmlFor={id}>{label}</label>
      <input
        {...props}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
      />
      {hint && (
        <p id={`${id}-hint`} className="wg-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="wg-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function Select({ label, children, id: supplied, ...props }: SelectProps) {
  const generated = useId();
  const id = supplied ?? generated;
  return (
    <div className="wg-field">
      <label htmlFor={id}>{label}</label>
      <select {...props} id={id}>
        {children}
      </select>
    </div>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  readonly children: React.ReactNode;
  readonly tone?: "neutral" | "accent" | "warning";
}) {
  return <span className={`wg-badge wg-badge--${tone}`}>{children}</span>;
}
export function StatePanel({ kind, title, children, action }: StatePanelProps) {
  return (
    <section className={`wg-state wg-state--${kind}`} aria-busy={kind === "loading"}>
      <span className="wg-state-symbol" aria-hidden="true">
        {kind === "loading" ? "◌" : kind === "error" || kind === "offline" ? "!" : "◇"}
      </span>
      <h2>{title}</h2>
      <div
        className="wg-state-description"
        role={kind === "error" ? "alert" : kind === "loading" ? "status" : undefined}
      >
        {children}
      </div>
      {action && <div className="wg-state-actions">{action}</div>}
    </section>
  );
}

/** Content viewers compose language/format overrides, Raw/Source switches and passive action buttons here. */
export function Toolbar({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="wg-toolbar">
      {children}
    </div>
  );
}
export function Panel({
  title,
  children,
  actions,
  className,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={`wg-panel ${className ?? ""}`}>
      <header className="wg-panel-header">
        <h2>{title}</h2>
        {actions}
      </header>
      <div className="wg-panel-body">{children}</div>
    </section>
  );
}
