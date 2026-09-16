/**
 * Request-body shape detection.
 *
 * Cursor's BYOK path is self-inconsistent: it posts to `/v1/chat/completions`
 * but often sends a Responses-API-shaped body, while its response parser expects
 * Chat Completions SSE. It also mixes shapes — a Chat-Completions top level with
 * a stray Responses-only `type:"custom"` tool inside it.
 *
 * This module is the single place that decides which dialect arrived, so the
 * capture log, the diagnostics, and the eventual translator all agree. It only
 * inspects; it never mutates.
 */

export const RESPONSES_ONLY_FIELDS = [
  "input",
  "instructions",
  "store",
  "include",
  "truncation",
  "prompt_cache_retention",
  "previous_response_id",
  "reasoning",
  "text",
  "max_output_tokens",
] as const;

export const CHAT_ONLY_FIELDS = [
  "messages",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "response_format",
  "reasoning_effort",
  "functions",
  "function_call",
] as const;

export type BodyKind = "responses" | "chat_completions" | "mixed" | "unknown";
export type ToolFormat = "none" | "nested" | "flat" | "custom" | "mixed";

export interface BodyShape {
  kind: BodyKind;
  hasMessages: boolean;
  hasInput: boolean;
  /** Responses allows `input` to be a bare string, which needs wrapping. */
  inputIsString: boolean;
  stream: boolean;
  model?: string;
  toolCount: number;
  toolFormat: ToolFormat;
  /** Names of Responses-only `type:"custom"` tools, e.g. `ApplyPatch`. */
  customTools: string[];
  responsesOnlyFields: string[];
  chatOnlyFields: string[];
  /** Every top-level key, so an unexpected field shows up in the capture. */
  topLevelKeys: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asToolList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Classify the tool array.
 *
 * Chat Completions nests under `function`; Responses flattens the name to the
 * top level; and Responses-only custom tools (`ApplyPatch`) have neither and
 * cannot be expressed in Chat Completions at all.
 */
function classifyTools(tools: unknown[]): { format: ToolFormat; custom: string[] } {
  if (tools.length === 0) return { format: "none", custom: [] };

  const seen = new Set<Exclude<ToolFormat, "mixed" | "none">>();
  const custom: string[] = [];

  for (const entry of tools) {
    const tool = asRecord(entry);
    if (!tool) continue;

    if (tool.type === "custom") {
      seen.add("custom");
      if (typeof tool.name === "string") custom.push(tool.name);
      continue;
    }

    if (asRecord(tool.function)) seen.add("nested");
    else if (typeof tool.name === "string") seen.add("flat");
  }

  if (seen.size === 0) return { format: "none", custom };
  if (seen.size === 1) {
    const [only] = [...seen];
    return { format: only ?? "none", custom };
  }
  return { format: "mixed", custom };
}

function hasAny(source: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((field) => source[field] !== undefined);
}

/**
 * Decide which dialect a request body is written in.
 *
 * Precedence matters: the presence of `input` is the strongest signal, because
 * Cursor has been observed sending `input` exclusively. Presence of `messages`
 * then decides between a clean Chat Completions body and a mixed one.
 */
export function classifyBody(body: unknown): BodyShape {
  const record = asRecord(body) ?? {};
  const hasInput = record.input !== undefined;
  const hasMessages = record.messages !== undefined;
  const tools = asToolList(record.tools);
  const { format: toolFormat, custom: customTools } = classifyTools(tools);

  let kind: BodyKind;
  if (hasInput) {
    // `input` alongside `messages` means the body is genuinely mixed.
    kind = hasMessages ? "mixed" : "responses";
  } else if (hasMessages) {
    // A Chat Completions top level can still carry Responses-only fragments.
    kind = toolFormat === "custom" || toolFormat === "mixed" || toolFormat === "flat"
      ? "mixed"
      : "chat_completions";
  } else {
    kind = "unknown";
  }

  return {
    kind,
    hasMessages,
    hasInput,
    inputIsString: typeof record.input === "string",
    stream: record.stream === true,
    model: typeof record.model === "string" ? record.model : undefined,
    toolCount: tools.length,
    toolFormat,
    customTools,
    responsesOnlyFields: hasAny(record, RESPONSES_ONLY_FIELDS),
    chatOnlyFields: hasAny(record, CHAT_ONLY_FIELDS),
    topLevelKeys: Object.keys(record).sort(),
  };
}

/** One-line summary for console output. */
export function describeShape(shape: BodyShape): string {
  const parts = [
    `kind=${shape.kind}`,
    `tools=${shape.toolFormat}(${shape.toolCount})`,
    shape.stream ? "stream" : "non-stream",
  ];
  if (shape.customTools.length > 0) parts.push(`custom=[${shape.customTools.join(",")}]`);
  if (shape.responsesOnlyFields.length > 0) {
    parts.push(`responses-only=[${shape.responsesOnlyFields.join(",")}]`);
  }
  return parts.join(" ");
}
