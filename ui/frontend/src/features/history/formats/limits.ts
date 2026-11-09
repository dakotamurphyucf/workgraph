/** Complete event preview ceiling, shared by loading and format projection.
 * Larger retained blobs remain available through verified streaming download. */
export const FORMAT_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 200_000,
  maxStringBytes: 16 * 1024 * 1024,
});
