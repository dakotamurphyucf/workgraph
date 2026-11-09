import type { ConnectionProfile } from "../core/protocol/types";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Primitives";

export function ConnectionsDialog({
  profiles,
  selectedId,
  onSelect,
  onClose,
  onRefresh,
}: {
  readonly profiles: readonly ConnectionProfile[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}) {
  return (
    <Dialog
      title="Daemon connections"
      description="These are saved connection profiles. A saved endpoint is not proof that its daemon is reachable."
      onClose={onClose}
    >
      <div className="wg-connection-list">
        {profiles.map((profile) => (
          <button
            type="button"
            key={profile.id}
            className="wg-connection-choice"
            onClick={() => {
              onSelect(profile.id);
            }}
          >
            <span className="wg-connection-mark" aria-hidden="true">
              w
            </span>
            <span className="wg-grow">
              <strong>{profile.label || profile.id}</strong>
              <small className="wg-code">{profile.socket}</small>
              <small>
                {profile.id} · Generation {profile.generation}
              </small>
            </span>
            {profile.id === selectedId && <span className="wg-badge">Selected</span>}
          </button>
        ))}
        {profiles.length === 0 && (
          <p className="wg-hint">
            No saved profiles. Connection setup will appear here when its feature is connected.
          </p>
        )}
      </div>
      <div className="wg-form-actions">
        <Button onClick={onRefresh}>Refresh profiles</Button>
        <Button onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  );
}
