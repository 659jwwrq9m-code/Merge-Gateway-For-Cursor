/**
 * Reshape Gateway's streaming responses into the dialect Cursor parses.
 *
 * Gateway speaks valid OpenAI, but it is not the flavour Cursor's Agent loop
 * expects. Pointed at Ollama Cloud's OpenAI interface the identical agent flow
 * works, so that response is the reference and Gateway's is normalised to match
 * it. The differences that matter:
 *
 *   - **Reasoning is `thinking`, not `reasoning`.** Cursor renders a
 *     `delta.reasoning` field. Gateway sends `delta.thinking`, which Cursor
 *     ignores, so the whole reasoning phase renders as nothing and the UI sits
 *     on "Planning next moves" while the model is in fact working.
 *   - **Nulls where Cursor wants empty values.** Ollama sends `"content":""`;
 *     Gateway sends `"content":null`. Likewise `tool_calls`, `annotations` and
 *     `thinking_signature` arrive as explicit nulls rather than being omitted.
 *   - **Long runs of no-op frames.** Gateway emits an all-null delta between
 *     every real one, so a turn is ~160 frames where Ollama needs ~10.
 *   - **Extra top-level keys** (`guardrails`, `routing`, `warnings`) that no
 *     OpenAI client asks for.
 *
 * A tool call is also delivered quite differently — Gateway puts the whole call
 * in a single frame, Ollama streams it — but that difference is benign, so the
 * fields are passed through rather than reassembled.
 */

/** Fields Gateway adds that a plain OpenAI client does not expect. */
const GATEWAY_ONLY_KEYS = ["guardrails", "routing", "warnings"] as const;

/** Delta keys that only ever carry Gateway's null placeholder. */
const NOISE_DELTA_KEYS = ["thinking_signature", "annotations"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Rewrite one streamed chunk.
 *
 * Returns undefined when the chunk carries nothing a client can use, so the
 * caller can drop it — that is what collapses Gateway's ~160 frames down to
 * something closer to Ollama's ~10, and it is safe because a delta with no
 * content, no reasoning, no tool call, no finish reason and no usage conveys
 * nothing.
 *
 * `requestedModel` is echoed back because Gateway answers with a bare provider
 * id (`deepseek-v4.1-flash`) where the client asked for the routed one
 * (`deepseek/deepseek-v4.1-flash`). A client matching on model id would
 * otherwise see a reply for a model it never requested.
 */
export function reshapeChunk(chunk: unknown, requestedModel?: string): unknown | undefined {
  if (!isRecord(chunk)) return chunk;

  const out: Record<string, unknown> = { ...chunk };

  for (const key of [...GATEWAY_ONLY_KEYS, ...NOISE_DELTA_KEYS]) delete out[key];
  if ("service_tier" in out && out.service_tier === null) delete out.service_tier;
  if ("system_fingerprint" in out && out.system_fingerprint === null) delete out.system_fingerprint;

  // Usage is meaningful only when populated; Gateway sends `"usage":null` on
  // every intermediate frame.
  if (out.usage === null || out.usage === undefined) delete out.usage;

  if (requestedModel) out.model = requestedModel;

  const choices = out.choices;
  if (!Array.isArray(choices)) return out;

  const reshapedChoices: unknown[] = [];
  for (const choice of choices) {
    if (!isRecord(choice)) {
      reshapedChoices.push(choice);
      continue;
    }

    const nextChoice: Record<string, unknown> = { index: choice.index ?? 0 };

    const delta = choice.delta;
    if (isRecord(delta)) {
      const nextDelta: Record<string, unknown> = {};

      if (typeof delta.role === "string" && delta.role) nextDelta.role = delta.role;

      // Always a string, never null — this is what Ollama does and what the
      // client tolerates.
      nextDelta.content = typeof delta.content === "string" ? delta.content : "";

      // The load-bearing rename: Cursor renders `reasoning`, not `thinking`.
      const reasoning =
        typeof delta.reasoning === "string"
          ? delta.reasoning
          : typeof delta.thinking === "string"
            ? delta.thinking
            : undefined;
      if (reasoning) nextDelta.reasoning = reasoning;

      // Passed through whole rather than reassembled: Gateway already sends one
      // complete call, which is valid to receive.
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        nextDelta.tool_calls = delta.tool_calls;
      }

      nextChoice.delta = nextDelta;
    } else if (delta !== undefined) {
      nextChoice.delta = delta;
    }

    // `finish_reason` comes after `delta` because that is the order Ollama emits
    // and this whole module exists to match Ollama's shape. A client that keys
    // off the raw text rather than parsing JSON would see a different stream
    // otherwise.
    if (choice.finish_reason !== undefined) nextChoice.finish_reason = choice.finish_reason;

    if (choice.logprobs !== undefined && choice.logprobs !== null) nextChoice.logprobs = choice.logprobs;

    reshapedChoices.push(nextChoice);
  }

  out.choices = reshapedChoices;

  // Drop frames that now carry nothing usable.
  const carriesSomething = reshapedChoices.some((choice) => {
    if (!isRecord(choice)) return true;
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) return true;
    const delta = choice.delta;
    if (!isRecord(delta)) return true;
    return Boolean(delta.role || delta.content || delta.reasoning || delta.tool_calls);
  });

  if (!carriesSomething && out.usage === undefined) return undefined;

  return out;
}

/**
 * Rewrite a complete non-streaming response.
 *
 * Same field moves as the streaming case, applied to `choices[].message`. The
 * tool-call path is the one that matters: a client reading `message.tool_calls`
 * must find it exactly where OpenAI puts it.
 */
export function reshapeCompletion(payload: unknown, requestedModel?: string): unknown {
  if (!isRecord(payload)) return payload;

  const out: Record<string, unknown> = { ...payload };
  for (const key of GATEWAY_ONLY_KEYS) delete out[key];
  if (out.system_fingerprint === null) delete out.system_fingerprint;
  if (requestedModel) out.model = requestedModel;

  const choices = out.choices;
  if (!Array.isArray(choices)) return out;

  out.choices = choices.map((choice) => {
    if (!isRecord(choice) || !isRecord(choice.message)) return choice;

    const message: Record<string, unknown> = { ...choice.message };
    // `reasoning` alongside the canonical `content`, mirroring the stream.
    if (typeof message.thinking === "string" && !message.reasoning) {
      message.reasoning = message.thinking;
    }
    delete message.thinking;
    delete message.thinking_signature;
    for (const key of NOISE_DELTA_KEYS) delete message[key];

    if (message.content === null && !Array.isArray(message.tool_calls)) message.content = "";
    if (message.tool_calls === null || message.tool_calls === undefined) delete message.tool_calls;

    return { ...choice, message };
  });

  return out;
}
