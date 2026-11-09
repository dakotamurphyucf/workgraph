import { useState } from "react";
import { Button, Toolbar } from "../../../components/Primitives";
import { Icon } from "../../../components/Icon";

type GuidePath = "draft" | "template" | "use";

/** Task-oriented help stays beside the editor without overwhelming the working form. */
export function PlanGuide({ initial = "draft" }: { readonly initial?: GuidePath }) {
  const [path, setPath] = useState<GuidePath>(initial);
  return (
    <details className="plan-guide">
      <summary>
        <Icon name="resources" />
        <span>New to workflows? Follow a worked example</span>
      </summary>
      <div className="plan-guide-body">
        <h3>Choose what you want to do</h3>
        <p>
          A <strong>draft</strong> is a saved plan of changes you have not necessarily applied yet.
          A <strong>template</strong> is a reusable recipe for creating a set of tickets. Both start
          as drafts in your browser; a template becomes shared only after you publish it.
        </p>
        <p>
          For a single ticket, <strong>Work → New ticket</strong> is the simpler route. Use a
          workflow draft when you want to prepare several connected changes and review them
          together.
        </p>
        <Toolbar label="Workflow learning paths">
          <Button aria-pressed={path === "draft"} onClick={() => setPath("draft")}>
            Create a one-off plan
          </Button>
          <Button aria-pressed={path === "template"} onClick={() => setPath("template")}>
            Build a reusable template
          </Button>
          <Button aria-pressed={path === "use"} onClick={() => setPath("use")}>
            Use a published template
          </Button>
        </Toolbar>
        {path === "draft" && (
          <>
            <h4>Example: plan two connected tickets</h4>
            <ol>
              <li>
                <strong>Choose your workspace, project and actor.</strong> Your actor is the person
                or agent credited with the changes. Choose <strong>New workflow draft</strong>, then
                give it a useful Workflow name, such as “Prepare the settings page”.
              </li>
              <li>
                <strong>Open the first Create work change.</strong> Change its Title from “New work”
                to “Build the settings page”. The selected project is filled in when available. More
                options contains description and other optional fields.
              </li>
              <li>
                <strong>Choose when agents may start.</strong> Under When can agents start this
                work?, choose Declared runnable intent if the ticket will be fully configured when
                you publish this batch. This means it may be claimed when its dependencies and rules
                are satisfied; it does not override those rules. A new workflow draft starts with
                one Create work change and no hold.
              </li>
              <li>
                <strong>Add other changes only when you need them.</strong> Choose an Operation to
                add and click Add operation. For example, add a second Create work with the title
                “Review the settings page”. Each create has an alias under Advanced: operation name
                and alias. Give them simple unique names, such as <code>build</code> and{" "}
                <code>review</code>. Set the second ticket’s intended availability too.
              </li>
              <li>
                <strong>Connect the tasks.</strong> Add prerequisite takes Ticket id (the task that
                waits) and Prerequisite id (the task that must finish first). In the same batch, use{" "}
                <code>$review</code> and <code>$build</code>. Aliases are temporary names, not live
                ticket IDs.
              </li>
              <li>
                <strong>Review, then apply deliberately.</strong> Click Review batch 1 and fix any
                reported issues. Save native operation saves the proposed action for recovery; it
                does not execute it. Then use the saved action’s explicit apply/execute control to
                commit the changes. Keep one batch for a first workflow: its changes succeed or fail
                together.
              </li>
              <li>
                <strong>Check the result in Work or Graph.</strong> Created tickets are now real.
                The review ticket waits for the build ticket. Dependencies and other rules still
                decide whether an agent can claim either ticket.
              </li>
            </ol>
            <p className="plan-guide-callout">
              When adding a ticket, decide whether it should remain held or be available once its
              requirements are met. The “When can agents start this work?” field records that
              intent; it does not create or lift a hold by itself. Held intent needs a Hold or
              release work change after the ticket creation in the same batch. Set that change’s
              Ticket id to the matching alias (for example, $build), expected revision to 1 for a
              newly created ticket, and a nonempty reason. Remove the hold later through the
              ticket’s Hold / lift hold action.
            </p>
          </>
        )}
        {path === "template" && (
          <>
            <h4>Example: a reusable Build → Review workflow</h4>
            <ol>
              <li>
                <strong>Choose Author template.</strong> Give the local source a recognizable name.
                Set Template ID to a stable identifier such as <code>feature-delivery</code>, and
                Published template title to “Feature delivery”. Keep the existing-resource revision
                at 0 for a new template.
              </li>
              <li>
                <strong>Add an input if the titles should vary.</strong> In Template specification →
                Parameters, add a row with <code>feature</code>. This is the name of an input the
                person using the template will fill in later.
              </li>
              <li>
                <strong>Describe the first task under Nodes.</strong> Nodes are the tasks this
                recipe will create. Open the first row; set Alias to <code>build</code> and Title to{" "}
                <code>{"Build {{feature}}"}</code>. Double braces substitute the input value. Add a
                description explaining what “done” means.
              </li>
              <li>
                <strong>Add a second node.</strong> Set Alias to <code>review</code>, Title to{" "}
                <code>{"Review {{feature}}"}</code>, and add <code>build</code> to Depends on. Here
                aliases are written without a dollar sign. That makes review wait for build. Parent
                is for grouping and does not create this dependency.
              </li>
              <li>
                <strong>Leave advanced rules alone unless you need them.</strong> Capabilities
                restrict which runs can claim a task; allowed actors restrict identities; reviewers
                and Separate actor configure review rules. You can learn those after your first
                template works.
              </li>
              <li>
                <strong>Build publication draft.</strong> This checks and converts your template
                into a separate publishable draft. Your original editable template draft remains
                saved. In the new draft, review its batch, save the proposed action, then explicitly
                apply/execute it.
              </li>
              <li>
                <strong>Return to Templates and refresh the list.</strong> The published template is
                now available to anyone connected to that workspace. Publishing the recipe does not
                create its tickets; Use template is the next step.
              </li>
            </ol>
          </>
        )}
        {path === "use" && (
          <>
            <h4>Example: create the workflow for a settings page</h4>
            <ol>
              <li>
                <strong>Choose a project and acting actor, then open Templates.</strong> Pick a
                published version and choose Use template. This creates a local draft; no tickets
                exist yet.
              </li>
              <li>
                <strong>Open Instantiate pinned template in the draft.</strong> Template ID and
                revision are already set to the version you chose. Supply a unique Instance id, such
                as <code>settings-page-01</code>, to identify this particular use.
              </li>
              <li>
                <strong>Fill in Parameters.</strong> For the example above, add a key named{" "}
                <code>feature</code> with the string value <code>settings page</code>. Every
                declared template parameter needs a value. Keep the project placement if it matches
                where you want the tickets.
              </li>
              <li>
                <strong>Review the batch.</strong> Check the expanded changes, save the proposed
                action, then explicitly apply/execute it. If review reports a missing field, fill it
                in and review again.
              </li>
              <li>
                <strong>Open Work or Graph.</strong> You should find “Build settings page” and
                “Review settings page”, with the review waiting on the build. The published template
                remains available for another feature with a different Instance id.
              </li>
            </ol>
          </>
        )}
        <div className="plan-guide-callout">
          <strong>What saves where?</strong> Draft edits autosave only in this browser at this
          address. All saved drafts returns to the list without deleting anything. Export downloads
          a portable backup. Remove deletes the browser’s draft, not existing tickets or published
          templates. Saving a proposed action preserves its recovery record; only applying/executing
          it changes Workgraph.
        </div>
      </div>
    </details>
  );
}
