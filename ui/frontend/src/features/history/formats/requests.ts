import type { JsonValue } from "../../../core/json";
import type { SourcePath } from "./types";
import type { Projection } from "./common";
import { anthropicBlocks } from "./anthropic";
import { responseItem } from "./openai";
import {
  array,
  object,
  field,
  identifier,
  integer,
  enumeration,
  string,
  required,
  mismatch,
} from "./validation";

/** Request envelopes give user turns a documented context. Arbitrary role/text
 * objects are not enough to infer a vendor. No API request is executed. */
export function anthropicRequest(value: JsonValue, path: SourcePath, out: Projection): void {
  const s = object(value, path);
  identifier(field(s, "model"), [...path, "model"]);
  integer(field(s, "max_tokens"), [...path, "max_tokens"]);
  for (const [i, raw] of array(field(s, "messages"), [...path, "messages"]).entries()) {
    const p = [...path, "messages", String(i)],
      m = object(raw, p);
    const role = enumeration(field(m, "role"), ["user", "assistant"], [...p, "role"]);
    anthropicBlocks(field(m, "content"), [...p, "content"], out, role, true);
  }
  const system = field(s, "system");
  if (system !== undefined) {
    // System instructions precede the conversation, regardless of JSON field order.
    const messages = out.items.splice(0);
    anthropicBlocks(system, [...path, "system"], out, "system", true);
    out.items.push(...messages);
  }
  out.model = out.report(string(field(s, "model"), [...path, "model"]), [...path, "model"]);
}
export function responseInput(value: JsonValue, path: SourcePath, out: Projection): void {
  const s = object(value, path);
  if (field(s, "output") !== undefined)
    mismatch(path, "Responses input envelope, not output response");
  identifier(field(s, "model"), [...path, "model"]);
  const instructions = field(s, "instructions");
  if (instructions !== undefined && instructions.kind !== "null")
    out.text(
      instructions,
      [...path, "instructions"],
      string(instructions, [...path, "instructions"]),
      "developer",
    );
  const input = required(field(s, "input"), [...path, "input"]);
  if (input.kind === "string") out.text(input, [...path, "input"], input.value, "user");
  else
    for (const [i, raw] of array(input, [...path, "input"]).entries()) {
      const p = [...path, "input", String(i)],
        m = object(raw, p),
        type = field(m, "type");
      if (type === undefined || (type.kind === "string" && type.value === "message")) {
        const role = enumeration(
            field(m, "role"),
            ["user", "assistant", "system", "developer"],
            [...p, "role"],
          ),
          content = required(field(m, "content"), [...p, "content"]);
        if (content.kind === "string") out.text(content, [...p, "content"], content.value, role);
        else
          for (const [n, block] of array(content, [...p, "content"]).entries()) {
            const at = [...p, "content", String(n)],
              b = object(block, at),
              kind = string(field(b, "type"), [...at, "type"]);
            if (kind === "input_text" || kind === "output_text")
              out.text(block, [...at, "text"], string(field(b, "text"), [...at, "text"]), role);
            else out.unsupported(block, at, `Attachment or input block: ${kind}`);
          }
      } else responseItem(raw, p, out);
    }
  out.model = out.report(string(field(s, "model"), [...path, "model"]), [...path, "model"]);
}
