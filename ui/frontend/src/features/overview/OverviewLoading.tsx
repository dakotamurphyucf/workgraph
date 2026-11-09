/** One coherent first-load surface; placeholders never masquerade as counters. */
export function OverviewLoading() {
  return (
    <div className="ov-loading" aria-busy="true">
      <p role="status">Loading Overview…</p>
      <div aria-hidden="true">
        <div className="ov-loading-title" />
        <div className="ov-loading-subtitle" />
        <div className="ov-loading-metrics">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index}>
              <span />
              <i />
            </div>
          ))}
        </div>
        <div className="ov-loading-columns">
          {[0, 1].map((column) => (
            <div key={column}>
              {[0, 1].map((card) => (
                <div className="ov-loading-card" key={card}>
                  <div className="ov-loading-card-heading" />
                  {[0, 1, 2].map((row) => (
                    <div className="ov-loading-row" key={row}>
                      <span />
                      <i />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
