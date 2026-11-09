import { useEffect, useRef, useState } from "react";
import { Button, Toolbar } from "../../../components/Primitives";
import type { ContentSource } from "../../../content/types";
import type { RasterPreview, ViewerResult, ViewerWorker } from "./types";
function useRaster(source: ContentSource, worker: ViewerWorker) {
  const [state, setState] = useState<{
      readonly source: ContentSource;
      readonly result: ViewerResult<RasterPreview>;
    } | null>(null),
    [unexpected, setUnexpected] = useState<{
      readonly source: ContentSource;
      readonly error: unknown;
    } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let bitmap: ImageBitmap | null = null;
    void worker
      .raster(source, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) {
          if (result.ok) result.value.bitmap.close();
          return;
        }
        if (result.ok) bitmap = result.value.bitmap;
        setState({ source, result });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setUnexpected({ source, error });
      });
    return () => {
      abort.abort();
      bitmap?.close();
    };
  }, [source, worker]);
  if (unexpected?.source === source) throw unexpected.error;
  return state?.source === source ? state.result : null;
}
function BitmapCanvas({
  preview,
  scale,
  opacity = 1,
  label,
}: {
  readonly preview: RasterPreview;
  readonly scale: number;
  readonly opacity?: number;
  readonly label: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable. Verified source remains retained.");
    context.drawImage(preview.bitmap, 0, 0);
  }, [preview]);
  return (
    <canvas
      ref={canvas}
      width={preview.bitmap.width}
      height={preview.bitmap.height}
      style={{
        width: preview.bitmap.width * scale,
        height: preview.bitmap.height * scale,
        opacity,
      }}
      role="img"
      aria-label={`${label}: ${preview.bitmap.width} by ${preview.bitmap.height} oriented pixels, static poster`}
    />
  );
}
export function RasterCanvas({
  left,
  right,
  label,
}: {
  readonly left: RasterPreview;
  readonly right?: RasterPreview;
  readonly label: string;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    [zoom, setZoom] = useState<number | null>(null),
    [fit, setFit] = useState(1),
    [opacity, setOpacity] = useState(0.5);
  const width = Math.max(left.bitmap.width, right?.bitmap.width ?? 0),
    height = Math.max(left.bitmap.height, right?.bitmap.height ?? 0);
  useEffect(() => {
    const target = viewport.current;
    if (!target) return;
    const resize = () =>
      setFit(Math.max(0.001, Math.min(1, (target.clientWidth - 32) / width, 400 / height)));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(target);
    return () => observer.disconnect();
  }, [width, height]);
  const scale = zoom ?? fit;
  const change = (n: number) => setZoom(Math.max(0.1, Math.min(8, n)));
  return (
    <section aria-label="Raster preview" className="wg-raster">
      <Toolbar label="Image controls">
        <Button onClick={() => setZoom(null)} aria-pressed={zoom === null}>
          Fit
        </Button>
        <Button onClick={() => setZoom(1)} aria-pressed={zoom === 1}>
          Actual pixels
        </Button>
        <Button aria-label="Zoom out" onClick={() => change(scale - 0.1)}>
          −
        </Button>
        <output aria-label="Image zoom">{Math.round(scale * 100)}%</output>
        <Button aria-label="Zoom in" onClick={() => change(scale + 0.1)}>
          +
        </Button>
        {right && (
          <label>
            Right overlay opacity{" "}
            <input
              aria-label="Right overlay opacity"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={opacity}
              onChange={(event) => setOpacity(Number(event.target.value))}
            />
          </label>
        )}
      </Toolbar>
      <p className="wg-hint">
        {left.bitmap.width} × {left.bitmap.height} oriented pixels ·{" "}
        {left.metadata.format.toUpperCase()}
        {left.metadata.orientation !== 1 ? ` · EXIF orientation ${left.metadata.orientation}` : ""}
        {left.metadata.animated ? " · Animated file; static first frame/poster only" : ""}.
        Keyboard: +/− zoom, 0 actual size, F fit, arrow keys pan. No animation playback.
      </p>
      {right && (
        <p className="wg-hint">
          Right: {right.bitmap.width} × {right.bitmap.height} oriented pixels ·{" "}
          {right.metadata.format.toUpperCase()}
          {right.metadata.orientation !== 1
            ? ` · EXIF orientation ${right.metadata.orientation}`
            : ""}
          {right.metadata.animated ? " · Animated file; static first frame/poster only" : ""}.
        </p>
      )}
      <div
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label={`${label} image viewport`}
        className="wg-raster-viewport"
        onKeyDown={(event) => {
          if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            change(scale + 0.1);
          } else if (event.key === "-") {
            event.preventDefault();
            change(scale - 0.1);
          } else if (event.key === "0") {
            event.preventDefault();
            setZoom(1);
          } else if (event.key.toLowerCase() === "f") {
            event.preventDefault();
            setZoom(null);
          } else if (event.key.startsWith("Arrow")) {
            event.preventDefault();
            const node = event.currentTarget;
            if (event.key === "ArrowLeft") node.scrollLeft -= 40;
            if (event.key === "ArrowRight") node.scrollLeft += 40;
            if (event.key === "ArrowUp") node.scrollTop -= 40;
            if (event.key === "ArrowDown") node.scrollTop += 40;
          }
        }}
      >
        <div className="wg-raster-stage" style={{ width: width * scale, height: height * scale }}>
          <BitmapCanvas preview={left} scale={scale} label={label} />
          {right && (
            <BitmapCanvas
              preview={right}
              scale={scale}
              opacity={opacity}
              label="Right comparison"
            />
          )}
        </div>
      </div>
    </section>
  );
}
export function RasterPane({
  source,
  worker,
}: {
  readonly source: ContentSource;
  readonly worker: ViewerWorker;
}) {
  const result = useRaster(source, worker);
  return !result ? (
    <p role="status">Checking raster bounds and decoding one static poster…</p>
  ) : !result.ok ? (
    <p role="alert">
      <strong>{result.kind}</strong>: {result.message}
    </p>
  ) : (
    <RasterCanvas left={result.value} label={source.label} />
  );
}
export function RasterOverlay({
  left,
  right,
  worker,
}: {
  readonly left: ContentSource;
  readonly right: ContentSource;
  readonly worker: ViewerWorker;
}) {
  const a = useRaster(left, worker),
    b = useRaster(right, worker);
  return !a || !b ? (
    <p role="status">Decoding two bounded static posters…</p>
  ) : !a.ok ? (
    <p role="alert">
      Left {a.kind}: {a.message}
    </p>
  ) : !b.ok ? (
    <p role="alert">
      Right {b.kind}: {b.message}
    </p>
  ) : (
    <RasterCanvas left={a.value} right={b.value} label="Left comparison" />
  );
}
