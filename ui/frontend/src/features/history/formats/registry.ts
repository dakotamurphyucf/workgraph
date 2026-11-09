import { FORMAT_LIMITS } from "./limits";
export { FORMAT_LIMITS } from "./limits";
import { parseJsonBytes } from "../../../core/json";
import type { JsonValue } from "../../../core/json";
import { conversationItem } from "./conversation-item";
import { claudeTranscript } from "./claude-transcript";
import { anthropicRequest, responseInput } from "./requests";
import { anthropicMessage } from "./anthropic";
import { claudeSdk } from "./claude-sdk";
import { codexRollout } from "./codex";
import { Projection } from "./common";
import { response, responseEvent, chatCompletion } from "./openai";
import type {
  AdapterDescriptor,
  CapturedPayload,
  FormatProjection,
  FormatSelection,
  ProjectionResult,
  SourcePath,
  ValidationIssue,
} from "./types";
import { ShapeMismatch } from "./validation";
const anthropic = "4c7b598466b88559583f98216139be8e9b34c1fc",
  openai = "44b1555aff1c22998c008c84400e7acce39fb928",
  codex = "7cdb2198831e3e6e647c31a1d5c409ab8acc8568";
interface Adapter {
  readonly descriptor: AdapterDescriptor;
  readonly decode: (value: JsonValue, path: SourcePath, projection: Projection) => void;
}
const adapters: readonly Adapter[] = [
  {
    descriptor: {
      id: "conversation.item.v1",
      label: "Conversation message or tool item",
      schemaPin: { name: "workgraph/conversation-item", revision: "1" },
      sources: [
        "https://developers.openai.com/api/reference/typescript/resources/responses",
        "https://platform.claude.com/docs/en/api/messages/create",
      ],
    },
    decode: conversationItem,
  },
  {
    descriptor: {
      id: "claude.code.transcript.v1",
      label: "Claude Code · session JSONL",
      schemaPin: { name: "claude-code-transcript-reader", revision: "claude-agent-sdk-0.3.319" },
      sources: [
        "https://code.claude.com/docs/en/agent-sdk/sessions",
        "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.319.tgz",
      ],
    },
    decode: claudeTranscript,
  },
  {
    descriptor: {
      id: "anthropic.messages.request.v1",
      label: "Anthropic Messages · conversation input",
      schemaPin: { name: "anthropic-sdk-python", revision: anthropic },
      sources: ["https://platform.claude.com/docs/en/api/messages/create"],
    },
    decode: anthropicRequest,
  },
  {
    descriptor: {
      id: "openai.responses.input.v1",
      label: "OpenAI Responses · conversation input",
      schemaPin: { name: "openai-python", revision: openai },
      sources: ["https://developers.openai.com/api/reference/typescript/resources/responses"],
    },
    decode: responseInput,
  },
  {
    descriptor: {
      id: "anthropic.messages.response.v1",
      label: "Anthropic Messages response",
      schemaPin: { name: "anthropic-sdk-python", revision: anthropic },
      sources: [
        `https://github.com/anthropics/anthropic-sdk-python/blob/${anthropic}/src/anthropic/types/message.py`,
        `https://github.com/anthropics/anthropic-sdk-python/blob/${anthropic}/src/anthropic/types/usage.py`,
      ],
    },
    decode: anthropicMessage,
  },
  {
    descriptor: {
      id: "openai.responses.object.v1",
      label: "OpenAI Responses object",
      schemaPin: { name: "openai-python", revision: openai },
      sources: [
        `https://github.com/openai/openai-python/blob/${openai}/src/openai/types/responses/response.py`,
      ],
    },
    decode: response,
  },
  {
    descriptor: {
      id: "openai.responses.event.v1",
      label: "OpenAI Responses complete event",
      schemaPin: { name: "openai-python", revision: openai },
      sources: [
        `https://github.com/openai/openai-python/tree/${openai}/src/openai/types/responses`,
      ],
    },
    decode: responseEvent,
  },
  {
    descriptor: {
      id: "openai.chat-completions.object.v1",
      label: "OpenAI Chat Completions object",
      schemaPin: { name: "openai-python", revision: openai },
      sources: [
        `https://github.com/openai/openai-python/blob/${openai}/src/openai/types/chat/chat_completion.py`,
      ],
    },
    decode: chatCompletion,
  },
  {
    descriptor: {
      id: "claude.agent-sdk.message.v1",
      label: "Claude Agent SDK message (0.3.319)",
      schemaPin: { name: "@anthropic-ai/claude-agent-sdk", revision: "0.3.319" },
      sources: [
        "https://code.claude.com/docs/en/agent-sdk/typescript",
        "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.319.tgz",
      ],
    },
    decode: claudeSdk,
  },
  {
    descriptor: {
      id: "codex.rollout-jsonl.7cdb219.v1",
      label: "Codex rollout (7cdb219)",
      schemaPin: { name: "openai/codex", revision: codex },
      sources: [
        `https://github.com/openai/codex/blob/${codex}/codex-rs/history/src/rollout_payload.rs`,
        `https://github.com/openai/codex/blob/${codex}/codex-rs/protocol/src/models.rs`,
      ],
    },
    decode: codexRollout,
  },
];
/** Closed local registry: no executable plugins, network discovery or whole-session detection. */
export const FORMAT_ADAPTERS: readonly AdapterDescriptor[] = Object.freeze(
  adapters.map(({ descriptor }) =>
    Object.freeze({
      ...descriptor,
      schemaPin: Object.freeze(descriptor.schemaPin),
      sources: Object.freeze(descriptor.sources),
    }),
  ),
);
/** One immutable complete payload. Unsupported/ambiguous results retain the same capture for Generic rendering. */
export function projectCapturedPayload(
  capture: CapturedPayload,
  selection: FormatSelection = "auto",
): ProjectionResult {
  const base = { capture, selection };
  if (selection === "generic")
    return { ...base, document: null, status: "generic", reason: "explicit-generic" };
  if (capture.completeness !== "complete")
    return { ...base, document: null, status: "unsupported", reason: "partial", issues: [] };
  if (capture.bytes.byteLength > FORMAT_LIMITS.maxBytes)
    return { ...base, document: null, status: "unsupported", reason: "byte-budget", issues: [] };
  const document = parseJsonBytes(capture.bytes, FORMAT_LIMITS);
  if (!document.ok) {
    if (document.error.code === "invalid_limits")
      throw new Error("History format parser limit invariant");
    const reason =
      document.error.code === "byte_limit"
        ? "byte-budget"
        : ["depth_limit", "node_limit", "string_limit"].includes(document.error.code)
          ? "parse-budget"
          : "invalid-json";
    return { ...base, document, status: "unsupported", reason, issues: [] };
  }
  const candidates: { descriptor: AdapterDescriptor; projection: FormatProjection }[] = [],
    issues: ValidationIssue[] = [];
  let producerMismatch = false;
  for (const adapter of adapters) {
    const descriptor = FORMAT_ADAPTERS.find((entry) => entry.id === adapter.descriptor.id);
    if (!descriptor) throw new Error("Registry descriptor invariant");
    if (selection !== "auto" && selection !== descriptor.id) continue;
    const out = new Projection(descriptor, capture);
    try {
      adapter.decode(document.value.value, [], out);
    } catch (error) {
      if (!(error instanceof ShapeMismatch)) throw error;
      issues.push({ adapter: descriptor.id, path: error.path, expected: error.expected });
      continue;
    }
    if (
      capture.producer !== null &&
      (capture.producer.name !== descriptor.schemaPin.name ||
        capture.producer.revision !== descriptor.schemaPin.revision)
    ) {
      producerMismatch = true;
      continue;
    }
    if (capture.producer === null)
      out.warnings.push(
        "Validated shape only; source producer/revision was not established. This bounded projection does not certify a complete upstream schema.",
      );
    candidates.push({ descriptor, projection: out.finish() });
  }
  if (candidates.length > 1)
    return {
      ...base,
      document,
      status: "ambiguous",
      candidates: candidates.map((c) => c.descriptor),
      reason: "multiple-validated-shapes",
    };
  const matched = candidates[0];
  if (matched)
    return {
      ...base,
      document,
      status: "recognized",
      adapter: matched.descriptor,
      recognition: capture.producer === null ? "validated-shape" : "producer-pinned",
      projection: matched.projection,
    };
  return {
    ...base,
    document,
    status: "unsupported",
    reason: producerMismatch
      ? "producer-mismatch"
      : selection === "auto"
        ? "no-adapter"
        : "schema-mismatch",
    issues,
  };
}
