import { useId, useRef, useState, type ReactNode } from "react";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Primitives";
import { Icon, type IconName } from "../components/Icon";
import { NAVIGATION } from "./navigation";
import type { ViewId } from "./types";
import "./command-design.css";
const SECTIONS: Record<
  "jump" | "search" | "actions",
  { readonly title: string; readonly icon: IconName; readonly detail: string }
> = {
  jump: {
    title: "Find your next destination",
    icon: "chevron",
    detail: "Search your workspace, return to a recent place, or open a Workgraph link.",
  },
  search: {
    title: "Search the work and its context",
    icon: "search",
    detail:
      "Find tickets, notes, resources and facts, or search imported session history. Choose what to search, then press Enter.",
  },
  actions: {
    title: "Go somewhere or change your setup",
    icon: "advanced",
    detail:
      "Open a page or choose your connection, workspace or acting identity. These shortcuts open a view; they do not submit changes to workspace data.",
  },
};
export interface CommandPaletteProps {
  readonly renderSearch?: (mode: "jump" | "search") => ReactNode;
  readonly onNavigate: (view: ViewId) => void;
  readonly onClose: () => void;
  readonly onConnections: () => void;
  readonly onWriter: () => void;
  readonly onScope: () => void;
}
export function CommandPalette({
  renderSearch,
  onNavigate,
  onClose,
  onConnections,
  onWriter,
  onScope,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"jump" | "search" | "actions">(renderSearch ? "jump" : "actions");
  const tabId = useId();
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const actions = [
    ...NAVIGATION.map((item) => ({
      id: item.id,
      group: "Pages",
      title: `Go to ${item.label}`,
      detail: item.description,
      icon: item.icon,
      run: () => {
        onNavigate(item.id);
      },
    })),
    {
      id: "connections",
      group: "Your setup",
      title: "Choose connection",
      detail: "Choose a saved daemon address, connect, or set up a local daemon.",
      icon: "connection" as const,
      run: onConnections,
    },
    {
      id: "writer",
      group: "Your setup",
      title: "Switch acting actor or run",
      detail: "Choose whose name and optional work run are attached to new actions.",
      icon: "participants" as const,
      run: onWriter,
    },
    {
      id: "scope",
      group: "Your setup",
      title: "Choose workspace and project scope",
      detail: "Choose which workspace and project the pages show.",
      icon: "resources" as const,
      run: onScope,
    },
  ].filter((action) =>
    `${action.title} ${action.detail}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  function move(direction: number) {
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>(".wg-command");
    if (!buttons?.length) return;
    const index = Array.from(buttons).findIndex((button) => button === document.activeElement);
    if (index === 0 && direction < 0) {
      input.current?.focus();
      return;
    }
    buttons[(index + direction + buttons.length) % buttons.length]?.focus();
  }
  return (
    <Dialog title="Command menu" onClose={onClose} wide>
      <div className="wg-command-menu" data-section={tab}>
        {renderSearch && (
          <div
            className="wg-command-tabs"
            role="tablist"
            aria-label="Command menu sections"
            onKeyDown={(event) => {
              const tabs = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
              );
              const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
              let next: number | undefined;
              if (event.key === "ArrowRight") next = (at + 1) % 3;
              if (event.key === "ArrowLeft") next = (at + 2) % 3;
              if (event.key === "Home") next = 0;
              if (event.key === "End") next = 2;
              if (next !== undefined) {
                event.preventDefault();
                tabs[next]?.click();
                tabs[next]?.focus();
              }
            }}
          >
            {(["jump", "search", "actions"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                id={`${tabId}-${value}`}
                aria-selected={tab === value}
                aria-controls={`${tabId}-panel`}
                tabIndex={tab === value ? 0 : -1}
                onClick={() => setTab(value)}
              >
                <Icon name={SECTIONS[value].icon} />
                {value[0]!.toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
        )}
        <div className="wg-command-intro">
          <span>
            <Icon name={SECTIONS[tab].icon} />
          </span>
          <div>
            <h3>{SECTIONS[tab].title}</h3>
            <p>{SECTIONS[tab].detail}</p>
          </div>
        </div>
        <div
          className="wg-command-panel"
          role="tabpanel"
          id={`${tabId}-panel`}
          aria-labelledby={renderSearch ? `${tabId}-${tab}` : undefined}
        >
          {tab !== "actions" && renderSearch ? (
            renderSearch(tab)
          ) : (
            <>
              <div className="wg-command-search">
                <Icon name="search" />
                <input
                  ref={input}
                  aria-label="Find a view or command"
                  placeholder="Find a view or command…"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      move(1);
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      actions[0]?.run();
                    }
                  }}
                />
              </div>
              <div
                className="wg-command-results"
                ref={list}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    move(event.key === "ArrowDown" ? 1 : -1);
                  }
                }}
              >
                {["Pages", "Your setup"].map((group) => {
                  const items = actions.filter((action) => action.group === group);
                  return items.length === 0 ? null : (
                    <section key={group} aria-label={group} className="wg-command-group">
                      <h3>{group}</h3>
                      {items.map((action) => (
                        <button
                          type="button"
                          key={action.id}
                          className="wg-command"
                          onClick={action.run}
                        >
                          <span className="wg-command-icon">
                            <Icon name={action.icon} />
                          </span>
                          <span>
                            <strong>{action.title}</strong>
                            <small>{action.detail}</small>
                          </span>
                          <Icon name="chevron" />
                        </button>
                      ))}
                    </section>
                  );
                })}
                {actions.length === 0 && (
                  <div className="wg-command-empty">
                    <Icon name="search" />
                    <h3>No matching commands</h3>
                    <p>
                      Try a page name such as Work or History, or a setting such as connection or
                      actor.
                    </p>
                    <Button
                      onClick={() => {
                        setQuery("");
                        input.current?.focus();
                      }}
                    >
                      Clear command search
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <footer className="wg-command-footer">
          <span>
            {tab === "actions" ? (
              <>
                <kbd>↑</kbd> <kbd>↓</kbd> Navigate
              </>
            ) : (
              <>
                <kbd>Tab</kbd> Navigate controls
              </>
            )}
          </span>
          <span>
            <kbd>Enter</kbd> Open
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </footer>
      </div>
    </Dialog>
  );
}
