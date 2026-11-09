import { Component, createRef, type ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
}
interface Snapshot {
  readonly scroller: HTMLElement;
  readonly candidates: readonly { readonly row: HTMLElement; readonly top: number }[];
}

/** Measure before React changes the DOM, then restore the first surviving visible
 * row before paint. Native scroll anchoring can choose a row leaving the rolling
 * window, so this owner replaces it. At the top, keep following newest activity.
 * User scrolling and deliberate query navigation remain ordinary browser actions. */
export class ActivityScrollAnchor extends Component<Props, Record<string, never>, Snapshot | null> {
  private rounding = 0;
  private readonly root = createRef<HTMLDivElement>();

  override getSnapshotBeforeUpdate(): Snapshot | null {
    const root = this.root.current;
    const scroller = root?.closest<HTMLElement>(".ac-scroll");
    if (!root || !scroller || scroller.scrollTop <= 0) return null;
    const viewport = scroller.getBoundingClientRect();
    const candidates = [...root.querySelectorAll<HTMLElement>(".ac-entry")]
      .map((row) => ({ row, rect: row.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > viewport.top && rect.top < viewport.bottom)
      .map(({ row, rect }) => ({ row, top: rect.top }));
    return { scroller, candidates };
  }

  override componentDidUpdate(
    _previous: Props,
    _state: Record<string, never>,
    snapshot: Snapshot | null,
  ) {
    const anchor = snapshot?.candidates.find(({ row }) => row.isConnected);
    if (snapshot && anchor) {
      const desired =
        snapshot.scroller.scrollTop +
        anchor.row.getBoundingClientRect().top -
        anchor.top +
        this.rounding;
      snapshot.scroller.scrollTop = Math.round(desired);
      const remainder = desired - snapshot.scroller.scrollTop;
      // Retain subpixel rounding only. Deliberately closing retained details can
      // shorten the document and clamp scrolling; that is not rounding debt.
      this.rounding = Math.abs(remainder) < 1 ? remainder : 0;
    } else this.rounding = 0;
  }

  override render() {
    return (
      <div ref={this.root} className="ac-timeline">
        {this.props.children}
      </div>
    );
  }
}
