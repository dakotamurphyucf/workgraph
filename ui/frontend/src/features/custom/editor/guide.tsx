import { Icon } from "../../../components/Icon";

/** Explanations are adjacent to the task; no knowledge of configuration schemas is required. */
export function SavedViewsGuide() {
  return (
    <section className="sv-guide" aria-label="Getting started with saved views">
      <div className="sv-guide-heading">
        <Icon name="saved" />
        <div>
          <h3>A reusable way to look at your work</h3>
          <p>
            A saved view remembers which records to show and how to arrange them. For example, keep
            a table of project tickets, a board grouped by status, or a list of research resources.
            It does not copy, move or change those records.
          </p>
        </div>
      </div>
      <ol className="sv-steps">
        <li>
          <strong>1 · Choose your records</strong>
          <p>
            Select a source, such as tickets, and where to look: the whole workspace or one project.
          </p>
        </li>
        <li>
          <strong>2 · Make it useful</strong>
          <p>
            Choose a layout and the information to display. Filters and sorting are optional; the
            starting ticket view already works.
          </p>
        </li>
        <li>
          <strong>3 · Save and open</strong>
          <p>
            Save privately to keep the setup on this local service. Activate view opens its results;
            saving alone does not open it.
          </p>
        </li>
      </ol>
      <details>
        <summary>Views, renderers and sharing — what is the difference?</summary>
        <dl className="sv-glossary">
          <div>
            <dt>View</dt>
            <dd>
              A reusable selection and layout of records. Start with New view for everyday work.
            </dd>
          </div>
          <div>
            <dt>Renderer</dt>
            <dd>
              An optional display recipe for a structured value, such as turning a JSON measurement
              into labeled fields. It changes presentation, not the stored data, and runs no custom
              code.
            </dd>
          </div>
          <div>
            <dt>Private library</dt>
            <dd>
              Settings saved by this local UI service for a particular connection and workspace.
              “Private” describes storage here; it is not an actor permission boundary or cloud
              account.
            </dd>
          </div>
          <div>
            <dt>Shared catalog</dt>
            <dd>
              A directory of configurations published into a workspace as resources. Other users can
              open a shared configuration as a draft and adapt it.
            </dd>
          </div>
          <div>
            <dt>Preferred</dt>
            <dd>
              A remembered selection in your library. It does not automatically activate a query.
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
export function BuilderGuide({ renderer }: { readonly renderer: boolean }) {
  return (
    <aside className="sv-help" aria-label="Builder instructions">
      <Icon name={renderer ? "advanced" : "saved"} />
      <div>
        <strong>{renderer ? "Create a display recipe" : "Start simple, then refine"}</strong>
        <p>
          {renderer
            ? "Choose the kind of value to match, then how to display its contents. Try sample JSON in Preview renderer before saving. A renderer does not fetch a collection of records; use a view for that."
            : "Give the view a name, choose its source and scope, then review its columns. You can keep the defaults for a first ticket view. Expand filters or ordering only when you need them."}
        </p>
        <p>
          <strong>Save privately</strong> keeps this configuration for later.{" "}
          {renderer ? (
            "Preview value tests sample data without publishing."
          ) : (
            <>
              <strong>Activate view</strong> reads the records and opens Results; it also works
              before saving.
            </>
          )}{" "}
          Switching tabs keeps this draft. <strong>Discard draft</strong> drops unsaved edits, not
          an already saved view or its records.
        </p>
      </div>
    </aside>
  );
}
