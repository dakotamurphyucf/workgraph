import { useEffect, useId, useRef } from "react";
import { Icon } from "./Icon";
import { Button } from "./Primitives";
import type { DialogProps } from "./types";

/** Native modal supplies inert background and focus containment. Escape/backdrop are explicit dismissal. */
export function Dialog({ title, description, children, onClose, wide = false }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`wg-dialog ${wide ? "wg-dialog--wide" : ""}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "button, a[href], input, select, textarea, summary, [tabindex]",
          ),
        ].filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(":disabled") &&
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== "hidden",
        );
        const first = controls[0],
          last = controls.at(-1);
        // Native inertness protects the page, but Chrome can otherwise tab to browser chrome.
        // Keep both ends of this explicit modal sequence inside the dialog.
        if (
          first &&
          last &&
          ((event.shiftKey && document.activeElement === first) ||
            (!event.shiftKey && document.activeElement === last))
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <header className="wg-dialog-header">
        <h2 id={titleId}>{title}</h2>
        <Button
          tone="quiet"
          className="wg-icon-button"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <Icon name="close" />
        </Button>
      </header>
      <div className="wg-dialog-body">
        {description && (
          <p id={descriptionId} className="wg-dialog-description">
            {description}
          </p>
        )}
        {children}
      </div>
    </dialog>
  );
}
