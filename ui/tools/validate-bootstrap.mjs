import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { parse } = await import(pathToFileURL(require.resolve("parse5")).href);

/** Parse build-owned HTML with browser HTML semantics; comments, text and
 * template contents are not active head metadata. No untrusted HTML is mounted. */
export function validateBootstrap(html, marker, assetPaths) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const metas = [];
  function walk(node, inHead = false) {
    const isHead = inHead || node.tagName === "head";
    const attrs = new Map((node.attrs ?? []).map(({ name, value }) => [name, value]));
    if (node.tagName === "meta" && attrs.get("name") === "workgraph-capability") {
      metas.push({ node, attrs, inHead: isHead });
    }
    for (const { name } of node.attrs ?? [])
      if (/^on[a-z]/i.test(name))
        throw new Error("Inline executable bootstrap content is forbidden");
    if (node.tagName === "script") {
      const source = attrs.get("src");
      if (
        !source ||
        (node.childNodes ?? []).some((child) => child.nodeName === "#text" && child.value.trim())
      )
        throw new Error("Inline executable bootstrap content is forbidden");
    }
    for (const name of ["src", "href"]) {
      const value = attrs.get(name);
      if (value !== undefined && (!value.startsWith("/assets/") || !assetPaths.has(value)))
        throw new Error(`Bootstrap reference is not an embedded asset: ${value}`);
    }
    // parse5 stores inert template children in node.content, which is deliberately
    // not traversed as active document metadata. A marker there cannot qualify.
    for (const child of node.childNodes ?? []) walk(child, isHead);
  }
  walk(document);
  if (
    metas.length !== 1 ||
    !metas[0].inHead ||
    metas[0].attrs.get("content") !== marker ||
    metas[0].attrs.size !== 2
  )
    throw new Error(
      "Capability marker must be the exact content of one workgraph-capability meta in head",
    );
  const source = metas[0].node.sourceCodeLocation;
  const tag = source && html.slice(source.startOffset, source.endOffset);
  // Reject duplicate attributes that an HTML parser normalizes away; accepted
  // build markup is deliberately this one unambiguous two-attribute tag.
  if (
    !tag ||
    !/^<meta\s+name="workgraph-capability"\s+content="__WORKGRAPH_UI_CAPABILITY__"\s*\/?\s*>$/i.test(
      tag,
    )
  )
    throw new Error("Capability marker meta must use the exact bootstrap placement");
}
