/**
 * Canned Chat Completions replies for capture mode.
 *
 * When the shim is not forwarding to Gateway, it still has to answer Cursor —
 * otherwise Cursor aborts on the first error and the interesting part of the
 * protocol (does it send tool results? does it try to apply an edit?) never
 * appears. So capture mode replies with a well-formed Chat Completions response
 * in whichever shape Cursor's parser is expecting.
 *
 * These are deliberately minimal but structurally valid, so they survive a
 * strict client parser.
 */

import { randomUUID } from "node:crypto";

export interface ReplyOptions {
  model: string;
  stream: boolean;
  /** Text returned to the model's caller. */
  content: string;
}

function envelope(model: string): { id: string; created: number } {
  return { id: `chatcmpl-shim-${randomUUID().replace(/-/g, "").slice(0, 20)}`, created: Math.floor(Date.now() / 1000) };
}

function usage(promptChars: number, completionChars: number) {
  // Rough character-based estimate; these numbers are only ever cosmetic.
  const prompt = Math.max(1, Math.ceil(promptChars / 4));
  const completion = Math.max(1, Math.ceil(completionChars / 4));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

export function jsonCompletion({ model, content }: ReplyOptions, promptChars = 0): string {
  const { id, created } = envelope(model);
  return JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: usage(promptChars, content.length),
  });
}

/**
 * Build the SSE body for a streaming completion.
 *
 * Chat Completions streams tool calls as fragments keyed by `index`; a reply
 * with no tool calls is simply role, content, then `finish_reason`, which is
 * what Cursor needs to render text and close the turn cleanly.
 */
export function sseCompletion({ model, content }: ReplyOptions, promptChars = 0): string {
  const { id, created } = envelope(model);
  const chunk = (delta: unknown, finishReason: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;

  // Split into a couple of deltas so incremental rendering is exercised.
  const midpoint = Math.max(1, Math.floor(content.length / 2));
  const parts = [content.slice(0, midpoint), content.slice(midpoint)].filter(Boolean);
  const chunks = [chunk({ role: "assistant", content: "" }, null)];

  for (const part of parts) chunks.push(chunk({ content: part }, null));

  chunks.push(chunk({}, "stop"));

  // The usage chunk is only sent when requested, matching the OpenAI contract.
  const final = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage: usage(promptChars, content.length),
  };
  chunks.push(`data: ${JSON.stringify(final)}\n\n`);
  chunks.push("data: [DONE]\n\n");

  return chunks.join("");
}

/** Warnings Cursor shows as an error card; used for deliberate refusals. */
export function errorBody(message: string, type = "invalid_request_error"): string {
  return JSON.stringify({ error: { message, type, code: null, param: null } });
}

// ---------------------------------------------------------------------------
// Responses API replies
//
// Needed for the case where a client posts a Responses-shaped body to
// /v1/responses and parses Responses SSE back. The shim's primary path is Chat
// Completions, but serving both means it survives either Cursor behaviour.
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}_shim_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

function responsesUsage(promptChars: number, completionChars: number) {
  const input = estimateTokens(promptChars);
  const output = estimateTokens(completionChars);
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

/** A completed assistant message, which is the only output item type emitted. */
function messageItem(itemId: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id: itemId,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function responseObject(
  responseId: string,
  model: string,
  text: string,
  promptChars: number,
  status: "in_progress" | "completed",
): Record<string, unknown> {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: status === "completed" ? [messageItem(newId("msg"), text)] : [],
    usage: status === "completed" ? responsesUsage(promptChars, text.length) : null,
  };
}

export function jsonResponse({ model, content }: ReplyOptions, promptChars = 0): string {
  return JSON.stringify(
    responseObject(newId("resp"), model, content, promptChars, "completed"),
  );
}

/**
 * Responses SSE.
 *
 * Emits the documented event order so a strict parser can follow it:
 * `response.created` → `output_item.added` → `content_part.added` →
 * `output_text.delta`* → `output_text.done` → `content_part.done` →
 * `output_item.done` → `response.completed`.
 *
 * Note there is no `[DONE]` sentinel: the Responses API ends on
 * `response.completed`, unlike Chat Completions.
 */
export function sseResponse({ model, content }: ReplyOptions, promptChars = 0): string {
  const responseId = newId("resp");
  const itemId = newId("msg");
  let sequence = 0;

  const event = (type: string, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`;

  // Split so incremental rendering is exercised rather than a single burst.
  const midpoint = Math.max(1, Math.floor(content.length / 2));
  const parts = [content.slice(0, midpoint), content.slice(midpoint)].filter(Boolean);

  const chunks = [
    event("response.created", {
      response: responseObject(responseId, model, "", promptChars, "in_progress"),
    }),
    event("response.in_progress", {
      response: responseObject(responseId, model, "", promptChars, "in_progress"),
    }),
    event("response.output_item.added", {
      output_index: 0,
      item: { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [] },
    }),
    event("response.content_part.added", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
  ];

  for (const part of parts) {
    chunks.push(
      event("response.output_text.delta", {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: part,
      }),
    );
  }

  chunks.push(
    event("response.output_text.done", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: content,
    }),
    event("response.content_part.done", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: content, annotations: [] },
    }),
    event("response.output_item.done", {
      output_index: 0,
      item: messageItem(itemId, content),
    }),
    event("response.completed", {
      response: {
        ...responseObject(responseId, model, content, promptChars, "completed"),
        output: [messageItem(itemId, content)],
      },
    }),
  );

  return chunks.join("");
}
