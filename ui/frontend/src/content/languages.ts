import type { CodeLanguage, ContentHints, FormatChoice, RenderOverride } from "./types";
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  "ocaml",
  "typescript",
  "javascript",
  "json",
  "bash",
  "python",
  "markdown",
  "yaml",
  "toml",
  "html",
  "css",
  "diff",
];
const aliases: Readonly<Record<string, CodeLanguage>> = {
  ocaml: "ocaml",
  ml: "ocaml",
  mli: "ocaml",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  python: "python",
  py: "python",
  markdown: "markdown",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "toml",
  html: "html",
  xml: "html",
  svg: "html",
  css: "css",
  diff: "diff",
  patch: "diff",
};
const mimeLanguages: Readonly<Record<string, CodeLanguage>> = {
  "text/x-ocaml": "ocaml",
  "text/typescript": "typescript",
  "application/typescript": "typescript",
  "text/javascript": "javascript",
  "application/javascript": "javascript",
  "application/json": "json",
  "text/json": "json",
  "application/x-sh": "bash",
  "text/x-shellscript": "bash",
  "text/x-python": "python",
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "application/yaml": "yaml",
  "text/yaml": "yaml",
  "application/x-yaml": "yaml",
  "application/toml": "toml",
  "text/toml": "toml",
  "text/html": "html",
  "application/xml": "html",
  "text/xml": "html",
  "image/svg+xml": "html",
  "text/css": "css",
  "text/x-diff": "diff",
};
export function languageHint(value: string | undefined): CodeLanguage | null {
  const key = value?.trim().toLowerCase().split(/[ \t]/u, 1)[0];
  return key && Object.hasOwn(aliases, key) ? (aliases[key] ?? null) : null;
}
export function resolveFormat(hints: ContentHints, override: RenderOverride): FormatChoice {
  if (override !== "auto")
    return {
      kind: override === "plain" ? "plain" : override === "markdown" ? "markdown" : "code",
      language: override === "plain" ? null : override,
      via: "override",
    };
  if (hints.language?.trim()) {
    const language = languageHint(hints.language);
    return { kind: language === "markdown" ? "markdown" : "code", language, via: "language" };
  }
  const mime = hints.mime?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime && Object.hasOwn(mimeLanguages, mime)) {
    const language = mimeLanguages[mime] ?? null;
    return { kind: language === "markdown" ? "markdown" : "code", language, via: "mime" };
  }
  if (
    mime &&
    (mime.startsWith("image/") ||
      mime.startsWith("audio/") ||
      mime.startsWith("video/") ||
      ["application/pdf", "application/zip", "application/gzip"].includes(mime))
  )
    return { kind: "binary", language: null, via: "mime" };
  // Generic octet-stream is an unknown type, not evidence of binary bytes.
  // The worker still rejects invalid UTF-8 and binary controls before rendering.
  const filename = hints.filename?.split(/[\\/]/u).pop();
  const language = filename?.includes(".") ? languageHint(filename.split(".").pop()) : null;
  if (language)
    return { kind: language === "markdown" ? "markdown" : "code", language, via: "filename" };
  if (hints.intent === "code") return { kind: "code", language: null, via: "intent" };
  return {
    kind: "markdown",
    language: "markdown",
    via: hints.intent === "prose" ? "intent" : "default",
  };
}
