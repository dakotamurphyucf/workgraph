import { describe, expect, it } from "vitest";
import { inspectRaster } from "../../../src/features/knowledge/viewers/raster";
import { fixtureBytes } from "./raster-fixtures";
describe("raster allocation guard", () => {
  it.each([
    ["png", "image/png", "png"],
    ["jpeg", "image/jpeg", "jpeg"],
    ["webp", "image/webp", "webp"],
    ["gif", "image/gif", "gif"],
  ] as const)(
    "recognizes independent %s fixture before any pixel allocation",
    (key, mime, format) => {
      expect(inspectRaster(fixtureBytes(key), mime)).toEqual({
        format,
        width: 6,
        height: 4,
        orientation: 1,
        animated: false,
      });
    },
  );
  it("detects independent animation containers and EXIF orientation", () => {
    expect(inspectRaster(fixtureBytes("animatedGif"), "image/gif").animated).toBe(true);
    expect(inspectRaster(fixtureBytes("animatedWebp"), "image/webp").animated).toBe(true);
    expect(inspectRaster(fixtureBytes("rotatedJpeg"), "image/jpeg").orientation).toBe(6);
  });
  it("refuses huge declared dimensions before invoking a decoder", () => {
    const png = fixtureBytes("png");
    new DataView(png.buffer).setUint32(16, 100000);
    expect(() => inspectRaster(png, "image/png")).toThrow("Decode was not started");
    const gif = fixtureBytes("gif");
    new DataView(gif.buffer).setUint16(6, 65535, true);
    expect(() => inspectRaster(gif, "image/gif")).toThrow("Decode was not started");
  });
  it("validates nested WebP bitstream dimensions, not only VP8X/ANMF claims", () => {
    const bytes = fixtureBytes("animatedWebp");
    const tag = new TextEncoder().encode("VP8L");
    let offset = -1;
    for (let i = 0; i < bytes.length - 4; i++)
      if (tag.every((v, j) => bytes[i + j] === v)) {
        offset = i;
        break;
      }
    expect(offset).toBeGreaterThan(0);
    const d = new DataView(bytes.buffer);
    const bits = d.getUint32(offset + 9, true);
    d.setUint32(offset + 9, (bits & 0xffffc000) | 0x3fff, true);
    expect(() => inspectRaster(bytes, "image/webp")).toThrow("Decode was not started");
  });
  it("keeps unsupported, MIME mismatch, malformed and encoded budget distinct", () => {
    expect(() => inspectRaster(new TextEncoder().encode("<svg/>"), "image/svg+xml")).toThrow(
      "Only PNG",
    );
    expect(() => inspectRaster(fixtureBytes("png"), "text/plain")).toThrow("MIME");
    expect(() => inspectRaster(fixtureBytes("gif").slice(0, -1), "image/gif")).toThrow("trailer");
    expect(() => inspectRaster(fixtureBytes("webp").slice(0, -1), "image/webp")).toThrow("length");
    expect(() => inspectRaster(new Uint8Array(8 * 1024 * 1024 + 1), "image/png")).toThrow("8MiB");
  });
  it("rejects out-of-canvas GIF frame rectangle", () => {
    const gif = fixtureBytes("gif"),
      index = gif.indexOf(0x2c);
    expect(index).toBeGreaterThan(0);
    new DataView(gif.buffer).setUint16(index + 1, 6, true);
    expect(() => inspectRaster(gif, "image/gif")).toThrow("beyond");
  });
});
