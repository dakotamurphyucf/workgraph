import * as d from "../../core/protocol/decoders";
import { jsonField, type JsonValue, type JsonLimits } from "../../core/json";
import type { ProtocolProcessor } from "../../core/protocol/worker";
import { fieldType, type FieldInput, type InputResult, type JsonObject } from "./fields";
import type { FieldDescriptor, MethodContract } from "./types";
const PARAMETER_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxDepth: 96,
  maxNodes: 100000,
  maxStringBytes: 4 * 1024 * 1024,
});
const OBSERVATION_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 96,
  maxNodes: 400000,
  maxStringBytes: 16 * 1024 * 1024,
});
export interface ParsedParameters {
  readonly params: JsonObject;
  readonly inputs: Readonly<Record<string, FieldInput>>;
}
export async function encode(
  processing: ProtocolProcessor,
  value: JsonValue,
  signal?: AbortSignal,
  budget: "parameters" | "observation" = "parameters",
): Promise<InputResult<string>> {
  const result = await processing.encode(value, {
    ...(signal ? { signal } : {}),
    limits: budget === "observation" ? OBSERVATION_LIMITS : PARAMETER_LIMITS,
  });
  if (!result.ok)
    return { ok: false, message: `${result.failure.kind}: ${result.failure.message}` };
  return result.value.ok
    ? { ok: true, value: result.value.value }
    : { ok: false, message: result.value.error.message };
}
export async function parseObject(
  processing: ProtocolProcessor,
  source: string,
  contract: MethodContract,
  signal: AbortSignal,
): Promise<InputResult<ParsedParameters>> {
  const result = await processing.parse(source, { signal, limits: PARAMETER_LIMITS });
  if (!result.ok)
    return { ok: false, message: `${result.failure.kind}: ${result.failure.message}` };
  if (!result.value.ok) return { ok: false, message: result.value.error.message };
  if (result.value.value.source !== source)
    return {
      ok: false,
      message: "protocol: Parameter decoder returned a different source capture.",
    };
  const params = result.value.value.value;
  if (params.kind !== "object") return { ok: false, message: "Parameters must be a JSON object." };
  const inputs: Record<string, FieldInput> = Object.fromEntries([]);
  for (const field of contract.fields.fields) {
    const value = jsonField(params, field.name);
    if (value === undefined)
      Object.defineProperty(inputs, field.name, {
        value: { presence: "omit", text: "" },
        enumerable: true,
      });
    else if (value.kind === "null")
      Object.defineProperty(inputs, field.name, {
        value: { presence: "null", text: "" },
        enumerable: true,
      });
    else if (fieldType(field) === "string" && value.kind === "string")
      Object.defineProperty(inputs, field.name, {
        value: { presence: "value", text: value.value },
        enumerable: true,
      });
    else {
      const text = await encode(processing, value, signal);
      if (!text.ok) return text;
      Object.defineProperty(inputs, field.name, {
        value: { presence: "value", text: text.value },
        enumerable: true,
      });
    }
  }
  return { ok: true, value: { params, inputs } };
}
export async function editedParams(
  processing: ProtocolProcessor,
  params: JsonObject,
  field: FieldDescriptor,
  input: FieldInput,
  signal: AbortSignal,
): Promise<InputResult<string>> {
  let value: JsonValue | undefined;
  if (input.presence === "null") value = d.jsonNull();
  else if (input.presence === "value") {
    if (fieldType(field) === "string") value = d.jsonString(input.text);
    else {
      const parsed = await processing.parse(input.text, { signal, limits: PARAMETER_LIMITS });
      if (!parsed.ok)
        return { ok: false, message: `${parsed.failure.kind}: ${parsed.failure.message}` };
      if (!parsed.value.ok) return { ok: false, message: parsed.value.error.message };
      value = parsed.value.value.value;
      const expected = fieldType(field);
      if (
        expected !== "json" &&
        !(
          expected === "integer" &&
          value.kind === "number" &&
          /^-?(0|[1-9][0-9]*)$/.test(value.lexeme)
        ) &&
        value.kind !== expected
      )
        return { ok: false, message: `Expected ${expected}; enter a complete JSON value.` };
    }
  }
  const fields = params.fields.filter((f) => f.name !== field.name);
  if (value !== undefined) fields.push({ name: field.name, value });
  return encode(processing, d.jsonObject(fields.map((f) => [f.name, f.value] as const)), signal);
}
