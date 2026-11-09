import type { FeatureContext } from "../../app/types";
import { Icon } from "../../components/Icon";
import { ReferencePicker } from "../discussions/ReferencePicker";
import { RecipientPicker } from "../discussions/RecipientPicker";
import type { ReferenceKind } from "../discussions/reference-choices";
import type { AdvancedDraft } from "./types";
import { identifier } from "../overview/model";

export function AdvancedGuide() {
  return (
    <div className="adv-guide">
      <section>
        <Icon name="advanced" />
        <div>
          <h3>What is Advanced for?</h3>
          <p>
            Use this explorer when you need a Workgraph operation that does not have a dedicated
            screen, want to inspect the API, or need to recover a saved request. The regular pages
            are usually the easiest place to manage everyday work.
          </p>
        </div>
      </section>
      <section>
        <Icon name="search" />
        <div>
          <h3>1 · Find an operation</h3>
          <p>
            A method is one named API operation, such as ticket.list. Search by name or description,
            then read its purpose and inputs. Methods with the same first word belong to a family.
            Helpers are guided instructions, not executable API methods.
          </p>
        </div>
      </section>
      <section>
        <Icon name="work" />
        <div>
          <h3>2 · Create and fill a draft</h3>
          <p>
            A draft is an editable set of inputs attached to the selected connection and actor.
            Opening one does not send a request. Fill the required fields, then optional settings if
            needed. Apply each edited field to the draft, or use JSON for the full parameter object.
            Unsent drafts survive page navigation in this browser session, not a reload.
          </p>
        </div>
      </section>
      <section>
        <Icon name="check" />
        <div>
          <h3>3 · Read, or review and apply</h3>
          <p>
            Run read sends a query and shows its result without applying a write. For a write,
            Validate &amp; prepare checks the request and saves its exact destination and inputs.
            Execute saved request sends it. Changing the app’s actor or workspace afterward does not
            retarget an existing draft or saved request.
          </p>
        </div>
      </section>
      <section>
        <Icon name="refresh" />
        <div>
          <h3>If an outcome is uncertain</h3>
          <p>
            Inspect checks the saved operation’s state. Recover receipt asks whether the daemon
            recorded it, when supported. Retry exact saved request resends the same request
            identity; it does not construct a new write. Preserve the saved request if you are
            unsure whether it succeeded.
          </p>
        </div>
      </section>
      <section>
        <Icon name="resources" />
        <div>
          <h3>Why JSON is available here</h3>
          <p>
            JSON is the structured format used by the API. Advanced intentionally exposes input,
            output and schema views for precise inspection. A schema describes allowed fields and
            values; native validation still checks the complete request. Ordinary task views do not
            require this level of detail.
          </p>
        </div>
      </section>
    </div>
  );
}

export function AdvancedChoice({
  context,
  draft,
  kind,
  label,
  value,
  onChange,
}: {
  readonly context: FeatureContext;
  readonly draft: AdvancedDraft;
  readonly kind: ReferenceKind | "actor";
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const endpoint = {
    connectionId: draft.selection.connection.id,
    generation: draft.selection.connection.generation,
    workspaceId: identifier(draft.selection.workspaceId!, "Workspace"),
  };
  const props = {
    context,
    endpoint,
    label,
    value,
    onChange,
    disabled: draft.locked || draft.preparing,
  };
  return kind === "actor" ? (
    <RecipientPicker {...props} />
  ) : (
    <ReferencePicker {...props} kind={kind} />
  );
}
