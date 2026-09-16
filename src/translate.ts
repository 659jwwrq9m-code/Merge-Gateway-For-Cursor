/**
 * Responses API → Chat Completions translation.
 *
 * Cursor's Agent path posts Responses-shaped bodies to `/v1/chat/completions`
 * while parsing Chat Completions SSE. Since Merge Gateway exposes a native
 * Chat Completions surface at `/v1/openai/chat/completions`, the most reliable
 * route is to normalise Cursor's request down to strict Chat Completions and let
 * Gateway do the rest — that keeps routing, budgets, and cost attribution
 * intact and avoids depending on Gateway's Responses-shape translation.
 *
 * Everything here is pure and synchronous, so it is straightforward to unit
 * test against a captured body.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Message content
// ---------------------------------------------------------------------------

/**
 * Flatten a Responses content part list into Chat Completions content.
 *
 * Returns a plain string when only text was present, which is the common case
 * and the shape every provider accepts; falls back to a part array when images
 * are involved.
 */
function convertContent(content: unknown): string | unknown[] | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts: unknown[] = [];
  let textOnly = true;

  for (const entry of content) {
    if (typeof entry === "string") {
      parts.push({ type: "text", text: entry });
      continue;
    }
    if (!isRecord(entry)) continue;

    const type = asString(entry.type);

    // Responses names text parts `input_text` / `output_text`; Chat uses `text`.
    if (type === "input_text" || type === "output_text" || type === "text") {
      parts.push({ type: "text", text: asString(entry.text) ?? "" });
      continue;
    }

    if (type === "input_image" || type === "image_url") {
      textOnly = false;
      const url = asString(entry.image_url) ?? (isRecord(entry.image_url) ? entry.image_url.url : undefined);
      if (typeof url === "string") parts.push({ type: "image_url", image_url: { url } });
      continue;
    }

    // Unknown part types are dropped rather than forwarded, because a provider
    // rejecting the whole request is worse than losing one part.
  }

  if (parts.length === 0) return undefined;
  if (textOnly) {
    return parts
      .map((part) => (isRecord(part) ? asString(part.text) ?? "" : ""))
      .join("");
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Input items → messages
// ---------------------------------------------------------------------------

function messageFromItem(item: Json): Json | undefined {
  const role = asString(item.role);
  const content = convertContent(item.content);
  if (!role) return undefined;

  // `developer` exists only in Responses and maps onto `system`.
  const mapped = role === "developer" ? "system" : role;
  return content === undefined ? { role: mapped } : { role: mapped, content };
}

function messagesFromInput(input: unknown): Json[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];

  const messages: Json[] = [];

  for (const raw of input) {
    if (typeof raw === "string") {
      messages.push({ role: "user", content: raw });
      continue;
    }
    if (!isRecord(raw)) continue;

    const type = asString(raw.type);

    // Tool result from Cursor, e.g. a file read or an apply-patch outcome.
    if (type === "function_call_output") {
      const callId = asString(raw.call_id);
      const output = raw.output;
      messages.push({
        role: "tool",
        ...(callId ? { tool_call_id: callId } : {}),
        content: typeof output === "string" ? output : JSON.stringify(output ?? ""),
      });
      continue;
    }

    // A prior assistant tool call, which must be echoed back for providers
    // that require the full call/result pair to be present.
    if (type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: asString(raw.call_id) ?? asString(raw.id) ?? "call_0",
            type: "function",
            function: {
              name: asString(raw.name) ?? "",
              arguments: asString(raw.arguments) ?? "{}",
            },
          },
        ],
      });
      continue;
    }

    // Reasoning items carry no Chat Completions equivalent.
    if (type === "reasoning") continue;

    // `type` is optional on plain input messages, so an item with a role but no
    // recognised type is treated as a message.
    const message = messageFromItem(raw);
    if (message) messages.push(message);
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Placeholder schema for `type:"custom"` tools.
 *
 * Responses' custom tools carry a free-form `format` (often a grammar) that has
 * no Chat Completions representation. They are the reason file edits fail while
 * chat still works, so they are promoted to a free-form function whose single
 * string argument holds the model's payload verbatim. That is lossy, but it
 * keeps the tool callable instead of rejected.
 */
function customToolToFunction(name: string, description: string | undefined): Json {
  return {
    type: "function",
    function: {
      name,
      description:
        description ??
        `${name} (forwarded by merge-gateway-shim from a Responses custom tool)`,
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "Raw tool payload, exactly as the tool expects it.",
          },
        },
        required: ["input"],
      },
    },
  };
}

function convertTools(tools: unknown): Json[] | undefined {
  const list = asArray(tools);
  if (list.length === 0) return undefined;

  const converted: Json[] = [];

  for (const raw of list) {
    if (!isRecord(raw)) continue;

    // Responses' built-in web search has no Chat equivalent here; dropping it is
    // safer than sending an unknown tool type upstream.
    if (raw.type === "web_search" || raw.type === "web_search_preview") continue;

    if (raw.type === "custom") {
      const name = asString(raw.name);
      if (name) converted.push(customToolToFunction(name, asString(raw.description)));
      continue;
    }

    // Already nested — pass through untouched.
    if (isRecord(raw.function)) {
      converted.push(raw);
      continue;
    }

    // Flat Responses function: lift `name`/`parameters` under `function`.
    if (raw.type === "function" || typeof raw.name === "string") {
      const name = asString(raw.name);
      if (!name) continue;
      converted.push({
        type: "function",
        function: {
          name,
          ...(asString(raw.description) !== undefined
            ? { description: asString(raw.description) }
            : {}),
          ...(isRecord(raw.parameters) ? { parameters: raw.parameters } : { parameters: { type: "object", properties: {} } }),
          ...(raw.strict !== undefined ? { strict: raw.strict } : {}),
        },
      });
    }
  }

  return converted.length > 0 ? converted : undefined;
}

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

/** Responses nests the format under `text`; Chat takes it at the top level. */
function convertTextFormat(text: unknown): Json | undefined {
  if (!isRecord(text)) return undefined;
  const format = text.format;
  if (!isRecord(format)) return undefined;

  if (format.type === "json_schema") {
    const schema = isRecord(format.json_schema) ? format.json_schema : format;
    return { type: "json_schema", json_schema: schema };
  }
  if (format.type === "json_object") return { type: "json_object" };
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface TranslateResult {
  body: Json;
  /** Human-readable notes on every change, surfaced in logs and captures. */
  notes: string[];
}

/**
 * Normalise a request body to strict Chat Completions.
 *
 * Idempotent: a body that is already Chat Completions comes back effectively
 * unchanged, which matters because Cursor sends both shapes and the shim should
 * not need to know which mode it is in.
 */
export function toChatCompletions(body: unknown): TranslateResult {
  const source = isRecord(body) ? body : {};
  const notes: string[] = [];
  const out: Json = {};

  // Fields common to both dialects are carried over verbatim.
  for (const key of [
    "model",
    "stream",
    "temperature",
    "top_p",
    "n",
    "stop",
    "seed",
    "user",
    "frequency_penalty",
    "presence_penalty",
    "logit_bias",
    "parallel_tool_calls",
    "tool_choice",
  ]) {
    if (source[key] !== undefined) out[key] = source[key];
  }

  // --- messages -----------------------------------------------------------
  const fromInput = messagesFromInput(source.input);
  const existing = asArray(source.messages).filter(isRecord) as Json[];

  if (fromInput.length > 0) {
    // `instructions` becomes a leading system message, matching Gateway's own
    // documented translation on its native Responses endpoint.
    const instructions = asString(source.instructions);
    const messages = instructions
      ? [{ role: "system", content: instructions }, ...fromInput]
      : fromInput;

    out.messages = existing.length > 0 ? [...existing, ...messages] : messages;
    notes.push(`input → messages (${messages.length}${instructions ? " +system" : ""})`);
  } else if (existing.length > 0) {
    out.messages = existing;
    notes.push(`messages kept (${existing.length})`);
  } else {
    // Nothing usable arrived. An empty message list is invalid upstream, so send
    // a single user turn and let the capture show what Cursor actually sent.
    out.messages = [{ role: "user", content: "" }];
    notes.push("no input or messages; sent empty user turn");
  }

  // --- tools --------------------------------------------------------------
  const tools = convertTools(source.tools);
  if (tools) {
    out.tools = tools;
    const custom = asArray(source.tools)
      .filter(isRecord)
      .filter((tool) => tool.type === "custom").length;
    if (custom > 0) notes.push(`${custom} custom tool(s) → free-form function`);
  }

  // --- token limits -------------------------------------------------------
  const maxTokens = source.max_completion_tokens ?? source.max_output_tokens ?? source.max_tokens;
  if (maxTokens !== undefined) {
    out.max_tokens = maxTokens;
    if (source.max_output_tokens !== undefined) notes.push("max_output_tokens → max_tokens");
  }

  // --- reasoning ----------------------------------------------------------
  if (source.reasoning_effort !== undefined) {
    out.reasoning_effort = source.reasoning_effort;
  } else if (isRecord(source.reasoning) && source.reasoning.effort !== undefined) {
    out.reasoning_effort = source.reasoning.effort;
    notes.push("reasoning.effort → reasoning_effort");
  }

  // --- structured output --------------------------------------------------
  if (source.response_format !== undefined) {
    out.response_format = source.response_format;
  } else {
    const format = convertTextFormat(source.text);
    if (format) {
      out.response_format = format;
      notes.push("text.format → response_format");
    }
  }

  // --- dropped Responses-only fields --------------------------------------
  const dropped: string[] = [];
  for (const key of [
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
    "stream_options",
  ]) {
    if (source[key] !== undefined) dropped.push(key);
  }
  if (dropped.length > 0) notes.push(`dropped [${dropped.join(",")}]`);

  // `stream_options` is Chat Completions-legal but Cursor sends the Responses
  // flavour (`include_usage`), which some upstreams reject; usage is emitted
  // regardless, so it is dropped above rather than forwarded.

  return { body: out, notes };
}
