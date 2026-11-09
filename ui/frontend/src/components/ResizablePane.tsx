import { useEffect, useRef, useState, type ReactNode } from "react";
import { clampWidth, keyboardWidth } from "./resize";
import type { InspectorProps, ResizablePaneProps } from "./types";
import { Button } from "./Primitives";
import { Icon } from "./Icon";

export function ResizablePane({
  id,
  label,
  side,
  initialWidth,
  onEscape,
  minimum,
  maximum,
  children,
  className = "",
}: ResizablePaneProps) {
  const limits = { minimum, maximum };
  const [width, setWidth] = useState(() => clampWidth(initialWidth, limits));
  const drag = useRef<{ x: number; width: number } | null>(null);
  const separator = (
    <div
      role="separator"
      aria-label={`Resize ${label}`}
      aria-controls={id}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={width}
      tabIndex={0}
      className="wg-resizer"
      onKeyDown={(event) => {
        const next = keyboardWidth(width, event.key, side, limits);
        if (next !== null) {
          event.preventDefault();
          setWidth(next);
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
      }}
      onPointerMove={(event) => {
        if (drag.current)
          setWidth(
            clampWidth(
              drag.current.width + (event.clientX - drag.current.x) * (side === "start" ? 1 : -1),
              limits,
            ),
          );
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    />
  );
  return (
    <div
      className={`wg-pane wg-pane--${side} ${className}`}
      style={{ width }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onEscape) {
          event.stopPropagation();
          onEscape();
        }
      }}
    >
      {side === "end" && separator}
      <div id={id} className="wg-pane-content">
        {children}
      </div>
      {side === "start" && separator}
    </div>
  );
}
export function Inspector({
  title,
  subtitle,
  children,
  onClose,
  initialWidth = 500,
  maximumWidth = 720,
}: InspectorProps) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    section.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <ResizablePane
      id="wg-inspector"
      label="inspector"
      onEscape={onClose}
      side="end"
      initialWidth={initialWidth}
      minimum={360}
      maximum={maximumWidth}
      className="wg-inspector"
    >
      <section
        aria-label={title}
        ref={section}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="wg-inspector-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="wg-hint">{subtitle}</p>}
          </div>
          <Button
            tone="quiet"
            className="wg-icon-button"
            aria-label="Close inspector"
            onClick={onClose}
          >
            <Icon name="close" />
          </Button>
        </header>
        <div className="wg-inspector-body">{children}</div>
      </section>
    </ResizablePane>
  );
}

export function SplitView({
  children,
  inspector,
}: {
  readonly children: ReactNode;
  readonly inspector?: ReactNode;
}) {
  return (
    <div className="wg-split-view">
      <div className="wg-split-main">{children}</div>
      {inspector}
    </div>
  );
}
