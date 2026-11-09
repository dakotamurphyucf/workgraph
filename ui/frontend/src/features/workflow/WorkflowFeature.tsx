import { Icon, type IconName } from "../../components/Icon";
import { ManagementPresentation } from "../connections/management-presentation";
import "./workflow-continuity.css";
import "../../components/section-navigation.css";
import { Button, Toolbar } from "../../components/Primitives";
import { LocalEvidenceFeature, type LocalEvidenceController } from "./local-evidence";
import { GraphFeature } from "./graph";
import type { GraphFeatureProps } from "./graph/types";
import { PlansFeature, type PlansController, type PlansView } from "./plans";

/** View choice is presentation only; launch-owned controllers retain every captured draft. */
export function WorkflowFeature({
  plans,
  localEvidence,
  ...graph
}: GraphFeatureProps & {
  readonly plans: PlansController;
  readonly localEvidence: LocalEvidenceController;
}) {
  const view =
    graph.context.route.section?.view === "workflow" ? graph.context.route.section.value : "graph";
  const setView = (value: "graph" | PlansView | "local-evidence") =>
    graph.context.navigate({
      ...graph.context.route,
      section: { view: "workflow", value },
    });
  const tabs = [
    ["graph", "Graph", "workflow"],
    ["relationships", "Relationships", "list"],
    ["templates", "Templates", "resources"],
    ["drafts", "Drafts", "saved"],
    ["local-evidence", "Execution evidence", "check"],
  ] as const satisfies readonly (readonly [string, string, IconName])[];
  return (
    <ManagementPresentation value={true}>
      <section className="workflow-hub" aria-label="Workflow workspace">
        <header className="workflow-navigation wg-section-navigation">
          <h1>
            <Icon name="workflow" />
            Workflow
          </h1>
          <Toolbar label="Workflow views">
            {tabs.map(([key, label, icon]) => (
              <Button
                key={key}
                tone="quiet"
                aria-pressed={view === key}
                onClick={() =>
                  graph.context.navigate({
                    ...graph.context.route,
                    entityId: null,
                    section: { view: "workflow", value: key },
                  })
                }
              >
                <Icon name={icon} />
                {label}
              </Button>
            ))}
          </Toolbar>
        </header>
        <div className={`workflow-view workflow-view--${view}`}>
          {view === "local-evidence" ? (
            <LocalEvidenceFeature context={graph.context} controller={localEvidence} />
          ) : view === "graph" || view === "relationships" ? (
            <GraphFeature {...graph} />
          ) : (
            <PlansFeature
              context={graph.context}
              controller={plans}
              operations={graph.operations}
              view={view}
              onView={setView}
            />
          )}
        </div>
      </section>
    </ManagementPresentation>
  );
}
