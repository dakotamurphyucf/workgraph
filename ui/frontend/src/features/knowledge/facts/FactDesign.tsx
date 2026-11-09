import type { ReactNode } from "react";
import type { FeatureContext } from "../../../app/types";
import { Icon, type IconName } from "../../../components/Icon";
import { ReferencePicker } from "../../discussions/ReferencePicker";
import type { ReferenceKind } from "../../discussions/reference-choices";
import type { FactTarget } from "./types";

/** Suggestions stay bound to the fact's captured workspace and endpoint. */
export function FactChoice({
  context,
  target,
  kind,
  label,
  value,
  onChange,
  disabled = false,
}: {
  readonly context: FeatureContext;
  readonly target: FactTarget;
  readonly kind: ReferenceKind;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  return (
    <ReferencePicker
      context={context}
      endpoint={{
        connectionId: target.connection.id,
        generation: target.connection.generation,
        workspaceId: target.workspaceId,
      }}
      kind={kind}
      label={label}
      value={value}
      onChange={onChange}
      disabled={disabled || context.connection.socket !== target.connection.socket}
    />
  );
}

export function FactSection({
  title,
  description,
  icon = "facts",
  children,
  tone = "blue",
}: {
  readonly title: string;
  readonly description: string;
  readonly icon?: IconName;
  readonly children: ReactNode;
  readonly tone?: "blue" | "purple" | "green" | "orange";
}) {
  return (
    <section className="fact-section" data-tone={tone}>
      <header>
        <Icon name={icon} />
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </header>
      <div className="fact-section-body">{children}</div>
    </section>
  );
}

export function FactsGuide() {
  return (
    <div className="fact-guide">
      <span className="fact-guide-icon">
        <Icon name="facts" />
      </span>
      <h2>Shared context, one key at a time</h2>
      <p>
        A fact is a small piece of shared information saved under a name, called a{" "}
        <strong>key</strong>. Use facts for decisions, settings, short findings or a worker’s latest
        checkpoint.
      </p>
      <div className="fact-guide-steps">
        <section>
          <b>1 · Choose where it belongs</b>
          <p>
            Facts live in a workspace, project, milestone or ticket. The same key can have different
            values in different places.
          </p>
        </section>
        <section>
          <b>2 · Name it and add a value</b>
          <p>
            For example, <code>release.ready</code> can hold true or false.{" "}
            <code>review.summary</code> can hold text or a few named fields.
          </p>
        </section>
        <section>
          <b>3 · Keep the team informed</b>
          <p>
            Changes record who saved them and when. Link a ticket or resource for context, and use
            History to revisit earlier values.
          </p>
        </section>
      </div>
      <details className="fact-help">
        <summary>What belongs in a fact?</summary>
        <p>
          Use facts for small, current information (up to 4 KiB per value). Use Resources for longer
          notes or files, Discussions for conversations, and Tickets for work to complete.
        </p>
        <p>
          A <strong>missing key</strong> has never been created in this scope. <strong>Null</strong>{" "}
          is an intentionally stored empty value. A <strong>deleted key</strong> has no current
          value, but its previous versions remain in history.
        </p>
      </details>
    </div>
  );
}
