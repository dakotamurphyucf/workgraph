import { VIEWER_LIMITS as L, ViewerProblem } from "./limits";
import type { RasterMetadata } from "./types";
const fail = (message: string): never => {
  throw new ViewerProblem("malformed", message);
};
function dimensions(width: number, height: number) {
  if (!width || !height) fail("Raster declares an empty canvas.");
  if (width > L.imageEdge || height > L.imageEdge || width * height > L.imagePixels)
    throw new ViewerProblem(
      "budget",
      "Raster exceeds 8192 pixels per edge or 16 million pixels. Decode was not started.",
    );
}
/** Header-only allocation guard; the browser remains responsible for compressed pixel validation.
 * Every bounded frame rectangle is checked, but only one static poster is decoded. */
export function inspectRaster(bytes: Uint8Array, mime: string): RasterMetadata {
  if (bytes.byteLength > L.imageBytes)
    throw new ViewerProblem(
      "budget",
      "Raster preview is limited to 8MiB encoded. Original bytes remain available.",
    );
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function need(offset: number, size: number) {
    if (offset < 0 || size < 0 || offset + size > bytes.length)
      fail("Truncated raster header or chunk.");
  }
  const u16 = (o: number, little = false) => {
    need(o, 2);
    return d.getUint16(o, little);
  };
  const u32 = (o: number, little = false) => {
    need(o, 4);
    return d.getUint32(o, little);
  };
  const u24 = (o: number) => {
    need(o, 3);
    return bytes[o]! + bytes[o + 1]! * 256 + bytes[o + 2]! * 65536;
  };
  const ascii = (o: number, n: number) => {
    need(o, n);
    return String.fromCharCode(...bytes.subarray(o, o + n));
  };
  function exif(t: number, end: number): number {
    const order = ascii(t, 2),
      little = order === "II";
    if (order !== "II" && order !== "MM") fail("Invalid EXIF byte order.");
    const word = (o: number) => {
      if (o < t || o + 2 > end) fail("EXIF field exceeds its segment.");
      return u16(o, little);
    };
    const long = (o: number) => {
      if (o < t || o + 4 > end) fail("EXIF field exceeds its segment.");
      return u32(o, little);
    };
    if (word(t + 2) !== 42) fail("Invalid EXIF TIFF header.");
    const dir = t + long(t + 4),
      count = word(dir);
    if (dir + 2 + count * 12 + 4 > end) fail("Truncated EXIF directory.");
    let orientation = 1;
    for (let i = 0; i < count; i++) {
      const q = dir + 2 + i * 12;
      if (word(q) === 0x112) {
        if (word(q + 2) !== 3 || long(q + 4) !== 1) fail("Invalid EXIF orientation field.");
        orientation = word(q + 8);
        if (orientation < 1 || orientation > 8) fail("Invalid EXIF orientation.");
      }
    }
    return orientation;
  }
  let format: RasterMetadata["format"],
    width = 0,
    height = 0,
    orientation = 1,
    animated = false;
  if (bytes.length >= 8 && ascii(0, 8) === "\x89PNG\r\n\x1a\n") {
    format = "png";
    let p = 8,
      ended = false,
      header = false;
    while (p < bytes.length) {
      need(p, 12);
      const n = u32(p),
        tag = ascii(p + 4, 4);
      need(p + 8, n + 4);
      if (!header) {
        if (tag !== "IHDR" || n !== 13) fail("PNG must start with its complete IHDR.");
        width = u32(p + 8);
        height = u32(p + 12);
        dimensions(width, height);
        header = true;
      } else if (tag === "IHDR") fail("Duplicate PNG header.");
      if (tag === "eXIf") orientation = exif(p + 8, p + 8 + n);
      if (tag === "acTL") {
        if (n !== 8 || u32(p + 8) === 0) fail("Invalid PNG animation header.");
        animated = true;
      }
      if (tag === "fcTL") {
        if (n !== 26) fail("Invalid PNG frame header.");
        const w = u32(p + 12),
          h = u32(p + 16);
        dimensions(w, h);
        if (w + u32(p + 20) > width || h + u32(p + 24) > height)
          fail("PNG frame extends beyond its canvas.");
      }
      p += 12 + n;
      if (tag === "IEND") {
        if (n !== 0 || p !== bytes.length) fail("Invalid PNG terminator.");
        ended = true;
        break;
      }
    }
    if (!header || !ended) fail("PNG has no complete terminal chunk.");
  } else if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    format = "gif";
    need(0, 13);
    width = u16(6, true);
    height = u16(8, true);
    dimensions(width, height);
    let p = 13,
      frames = 0,
      ended = false;
    const packed = bytes[10]!;
    if (packed & 128) p += 3 * (1 << ((packed & 7) + 1));
    need(0, p);
    function blocks() {
      while (true) {
        need(p, 1);
        const n = bytes[p++]!;
        if (n === 0) return;
        need(p, n);
        p += n;
      }
    }
    while (p < bytes.length) {
      const tag = bytes[p++]!;
      if (tag === 0x3b) {
        ended = true;
        if (p !== bytes.length) fail("Data follows GIF terminator.");
        break;
      }
      if (tag === 0x21) {
        need(p, 1);
        p++;
        blocks();
        continue;
      }
      if (tag !== 0x2c) fail("Unknown GIF block.");
      need(p, 9);
      const x = u16(p, true),
        y = u16(p + 2, true),
        w = u16(p + 4, true),
        h = u16(p + 6, true),
        flags = bytes[p + 8]!;
      dimensions(w, h);
      if (x + w > width || y + h > height) fail("GIF frame extends beyond its canvas.");
      p += 9;
      if (flags & 128) p += 3 * (1 << ((flags & 7) + 1));
      need(p, 1);
      p++;
      blocks();
      frames++;
    }
    if (!frames || !ended) fail("GIF has no complete image and trailer.");
    animated = frames > 1;
  } else if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    format = "webp";
    if (u32(4, true) + 8 !== bytes.length) fail("WebP RIFF length differs from captured bytes.");
    function pixels(tag: string, s: number, n: number): readonly [number, number] {
      let w: number, h: number;
      if (tag === "VP8 ") {
        if (n < 10 || ascii(s + 3, 3) !== "\x9d\x01\x2a") fail("Invalid WebP VP8 frame header.");
        w = u16(s + 6, true) & 0x3fff;
        h = u16(s + 8, true) & 0x3fff;
      } else {
        if (n < 5 || bytes[s] !== 0x2f) fail("Invalid WebP lossless frame header.");
        const bits = u32(s + 1, true);
        w = (bits & 0x3fff) + 1;
        h = ((bits >>> 14) & 0x3fff) + 1;
      }
      dimensions(w, h);
      return [w, h];
    }
    let p = 12,
      frames = 0;
    while (p < bytes.length) {
      need(p, 8);
      const tag = ascii(p, 4),
        n = u32(p + 4, true),
        s = p + 8;
      need(s, n);
      if (tag === "VP8X") {
        if (n !== 10 || width) fail("Invalid WebP extended header.");
        width = u24(s + 4) + 1;
        height = u24(s + 7) + 1;
        animated = (bytes[s]! & 2) !== 0;
        dimensions(width, height);
      }
      if (tag === "VP8 " || tag === "VP8L") {
        const [w, h] = pixels(tag, s, n);
        if (width && (width !== w || height !== h))
          fail("WebP bitstream differs from its declared canvas.");
        width = w;
        height = h;
      }
      if (tag === "EXIF")
        orientation = exif(n >= 6 && ascii(s, 6) === "Exif\0\0" ? s + 6 : s, s + n);
      if (tag === "ANMF") {
        if (n < 16 || !width || !animated) fail("Invalid WebP animation frame.");
        const w = u24(s + 6) + 1,
          h = u24(s + 9) + 1;
        dimensions(w, h);
        if (u24(s) * 2 + w > width || u24(s + 3) * 2 + h > height)
          fail("WebP frame extends beyond its canvas.");
        let q = s + 16,
          bitstreams = 0;
        while (q < s + n) {
          if (q + 8 > s + n) fail("Truncated WebP frame subchunk.");
          const inner = ascii(q, 4),
            length = u32(q + 4, true),
            data = q + 8;
          if (data + length + (length & 1) > s + n)
            fail("WebP frame subchunk exceeds its container.");
          if (inner === "VP8 " || inner === "VP8L") {
            const [pw, ph] = pixels(inner, data, length);
            if (pw !== w || ph !== h)
              fail("WebP frame bitstream differs from its bounded frame rectangle.");
            bitstreams++;
          }
          q = data + length + (length & 1);
        }
        if (bitstreams !== 1) fail("WebP frame requires one bounded pixel bitstream.");
        frames++;
      }
      p = s + n + (n & 1);
      need(0, p);
    }
    if (!width || !height || (animated && frames === 0))
      fail("WebP has no complete bounded image header.");
  } else if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 216) {
    format = "jpeg";
    let p = 2;
    while (p < bytes.length) {
      need(p, 2);
      if (bytes[p++] !== 255) fail("Invalid JPEG marker.");
      while (bytes[p] === 255) p++;
      need(p, 1);
      const marker = bytes[p++]!;
      if (marker === 0xd9) break;
      if (marker === 0xda) {
        need(p, 2);
        const n = u16(p);
        need(p, n);
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const n = u16(p);
      if (n < 2) fail("Invalid JPEG segment length.");
      need(p, n);
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (n < 8) fail("Truncated JPEG frame.");
        const h = u16(p + 3),
          w = u16(p + 5);
        dimensions(w, h);
        if (width && (width !== w || height !== h))
          fail("JPEG frames disagree on canvas dimensions.");
        width = w;
        height = h;
      }
      if (marker === 0xe1 && n >= 16 && ascii(p + 2, 6) === "Exif\0\0") {
        orientation = exif(p + 8, p + n);
      }
      p += n;
    }
    if (!width || !height || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
      fail("JPEG lacks a complete frame or terminator.");
  } else
    throw new ViewerProblem(
      "unsupported",
      "Only PNG, JPEG, WebP and GIF raster signatures are supported. SVG and HTML remain source only.",
    );
  const expected = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[
    format
  ];
  if (mime.split(";")[0]?.trim().toLowerCase() !== expected)
    fail(`Declared MIME does not match the ${format.toUpperCase()} byte signature.`);
  return { format, width, height, orientation, animated };
}
