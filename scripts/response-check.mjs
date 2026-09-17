#!/usr/bin/env node
/**
 * Response-translation checks.
 *
 * The bug this guards: pointed at Cursor, Gateway's Agent mode sat on
 * "Planning next moves…" and then "reconnecting…" forever, even though the same
 * agent flow works against Ollama Cloud's OpenAI interface. The cause is a
 * dialect difference in the *response*, not the request.
 *
 * Ollama Cloud is treated as the reference because it demonstrably works, and
 * the frames below were captured from it directly:
 *
 *   data: {"id":"chatcmpl-762","object":"chat.completion.chunk",...,
 *          "choices":[{"index":0,"delta":{"role":"assistant","content":"",
 *          "reasoning":"The"},"finish_reason":null}]}
 *
 * Gateway answers the same request with `delta.thinking` instead of
 * `delta.reasoning`, `content:null` instead of `content:""`, explicit nulls for
 * `tool_calls`/`annotations`/`thinking_signature`, extra `guardrails`/`routing`/
 * `warnings` keys, and a no-op frame between every real one. Cursor renders
 * `reasoning` and ignores `thinking`, so the model appears to be doing nothing.
 *
 * Run with:  node scripts/response-check.mjs
 */

import { reshapeChunk, reshapeChunks, reshapeCompletion } from "../dist/reshape.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
};

console.log("response translation");

// --- the load-bearing rename -------------------------------------------------

{
  const gateway = {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1789594040,
    model: "deepseek-v4.1-flash",
    choices: [{ index: 0, delta: { content: null, thinking: "The user wants" }, finish_reason: null }],
  };
  const out = reshapeChunk(gateway, "deepseek/deepseek-v4.1-flash");
  const delta = out?.choices?.[0]?.delta;

  check("thinking becomes reasoning", delta?.reasoning === "The user wants", JSON.stringify(delta));
  check("thinking is removed", !("thinking" in (delta ?? {})), JSON.stringify(delta));
  check("content null becomes empty string", delta?.content === "", JSON.stringify(delta));
  check(
    "model is restored to the requested id",
    out?.model === "deepseek/deepseek-v4.1-flash",
    String(out?.model),
  );
}

// --- gateway-only keys and null placeholders --------------------------------

{
  const gateway = {
    id: "chatcmpl-2",
    model: "deepseek-v4.1-flash",
    guardrails: null,
    routing: { provider: "deepseek" },
    warnings: [],
    service_tier: null,
    system_fingerprint: null,
    usage: null,
    choices: [
      {
        index: 0,
        delta: {
          content: "hi",
          annotations: null,
          thinking_signature: null,
          tool_calls: null,
        },
        finish_reason: null,
      },
    ],
  };
  const out = reshapeChunk(gateway);
  const delta = out?.choices?.[0]?.delta;

  check("guardrails dropped", !("guardrails" in (out ?? {})));
  check("routing dropped", !("routing" in (out ?? {})));
  check("warnings dropped", !("warnings" in (out ?? {})));
  check("null service_tier dropped", !("service_tier" in (out ?? {})));
  check("null system_fingerprint dropped", !("system_fingerprint" in (out ?? {})));
  check("null usage dropped", !("usage" in (out ?? {})));
  check("null annotations dropped", !("annotations" in (delta ?? {})));
  check("null thinking_signature dropped", !("thinking_signature" in (delta ?? {})));
  check("null tool_calls dropped", !("tool_calls" in (delta ?? {})), JSON.stringify(delta));
  check("real content kept", delta?.content === "hi", JSON.stringify(delta));
}

// --- no-op frames are dropped ------------------------------------------------

{
  // Gateway emits one of these between every meaningful frame.
  const empty = {
    id: "chatcmpl-3",
    model: "deepseek-v4.1-flash",
    usage: null,
    choices: [
      {
        index: 0,
        delta: {
          content: null,
          thinking: null,
          tool_calls: null,
          annotations: null,
          thinking_signature: null,
        },
        finish_reason: null,
      },
    ],
  };

  check("all-null delta frame is dropped", reshapeChunk(empty) === undefined);

  // But a terminal frame must survive: it carries the finish reason.
  const done = {
    id: "chatcmpl-4",
    model: "deepseek-v4.1-flash",
    choices: [{ index: 0, delta: { content: null }, finish_reason: "tool_calls" }],
  };
  const out = reshapeChunk(done);
  check("finish_reason frame survives", out?.choices?.[0]?.finish_reason === "tool_calls", JSON.stringify(out));
}

// --- usage frames survive ----------------------------------------------------

{
  const withUsage = {
    id: "chatcmpl-5",
    model: "deepseek-v4.1-flash",
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    choices: [{ index: 0, delta: { content: null }, finish_reason: null }],
  };
  const out = reshapeChunk(withUsage);
  check("populated usage frame survives", out?.usage?.total_tokens === 12, JSON.stringify(out));
}

// --- tool calls pass through intact ------------------------------------------

{
  const toolFrame = {
    id: "chatcmpl-6",
    model: "deepseek-v4.1-flash",
    choices: [
      {
        index: 0,
        delta: {
          content: "",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "Shell", arguments: '{"command":"ls"}' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  const out = reshapeChunk(toolFrame);
  const call = out?.choices?.[0]?.delta?.tool_calls?.[0];

  check("tool call id preserved", call?.id === "call_1", JSON.stringify(call));
  check("tool call name preserved", call?.function?.name === "Shell", JSON.stringify(call));
  check(
    "tool call arguments preserved byte-for-byte",
    call?.function?.arguments === '{"command":"ls"}',
    JSON.stringify(call),
  );
}

// --- role frames -------------------------------------------------------------

{
  const roleFrame = {
    id: "chatcmpl-7",
    model: "deepseek-v4.1-flash",
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  };
  const out = reshapeChunk(roleFrame);
  check("role frame survives with role intact", out?.choices?.[0]?.delta?.role === "assistant", JSON.stringify(out));
}

// --- malformed input is never destructive ------------------------------------

{
  check("non-object chunk passes through", reshapeChunk("nonsense") === "nonsense");
  check("null chunk passes through", reshapeChunk(null) === null);
  const noChoices = { id: "x", model: "m" };
  check("chunk without choices is returned", reshapeChunk(noChoices) !== undefined);
}

// --- non-streaming completion ------------------------------------------------

{
  const completion = {
    id: "chatcmpl-8",
    object: "chat.completion",
    model: "deepseek-v4.1-flash",
    guardrails: null,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          thinking: "reasoning text",
          thinking_signature: null,
          annotations: null,
          tool_calls: [
            { id: "call_9", type: "function", function: { name: "Read", arguments: '{"path":"a"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const out = reshapeCompletion(completion, "deepseek/deepseek-v4.1-flash");
  const message = out?.choices?.[0]?.message;

  check("completion reasoning surfaced", message?.reasoning === "reasoning text", JSON.stringify(message));
  check("completion thinking removed", !("thinking" in (message ?? {})));
  check("completion tool_calls preserved", message?.tool_calls?.[0]?.function?.name === "Read", JSON.stringify(message));
  check("completion guardrails dropped", !("guardrails" in (out ?? {})));
  check("completion model restored", out?.model === "deepseek/deepseek-v4.1-flash", String(out?.model));
}

// ---------------------------------------------------------------------------
// Parallel tool calls.
//
// The bug this guards: Cursor could only spawn ONE sub-agent at a time; the
// rest failed silently. Same model, same prompt, streaming — the only
// difference is how the calls are divided across frames.
//
// Measured against both providers (glm-5.3-flash, three Task calls requested):
//
//   Ollama  -> 3 frames, each carrying 1 call   -> Cursor spawns 3
//   Gateway -> 1 frame  carrying 3 calls        -> Cursor spawns 1
//
// Cursor accumulates `tool_calls` per frame, so N-in-one reads as one call.
// `reshapeChunks` splits that frame; everything else is untouched.
//
// The fixture below is the REAL Gateway frame, captured verbatim.
console.log("\nparallel tool calls: splitting a multi-call frame");

const realGatewayFrame = {
  id: "chatcmpl-cc_5e8b983ba6bc0bde",
  object: "chat.completion.chunk",
  created: 1789626519,
  model: "glm-5.3-flash",
  choices: [
    {
      index: 0,
      delta: {
        role: null,
        content: null,
        tool_calls: [
          {
            index: 0,
            id: "call_89d4a23ac097453f8f2eb192",
            type: "function",
            function: { name: "Task", arguments: '{"description": "Spawn agent alpha"}' },
          },
          {
            index: 1,
            id: "call_5b4f3f5e78564e5eb31a8e40",
            type: "function",
            function: { name: "Task", arguments: '{"description": "Spawn agent beta"}' },
          },
          {
            index: 2,
            id: "call_6e1cf4e900d54b6889126e44",
            type: "function",
            function: { name: "Task", arguments: '{"description": "Spawn agent gamma"}' },
          },
        ],
        annotations: null,
        thinking: null,
        thinking_signature: null,
      },
      finish_reason: null,
      logprobs: null,
    },
  ],
  usage: null,
  system_fingerprint: null,
  service_tier: null,
  routing: null,
  guardrails: null,
  warnings: null,
};

{
  const frames = reshapeChunks(realGatewayFrame, "zai/glm-5.3-flash");

  check("one Gateway frame becomes three", frames.length === 3, `got ${frames.length}`);

  const calls = frames.map((f) => f?.choices?.[0]?.delta?.tool_calls ?? []);
  check(
    "each frame carries exactly one call",
    calls.length === 3 && calls.every((c) => c.length === 1),
    JSON.stringify(calls.map((c) => c.length)),
  );
  check(
    "all three call ids survive, in order",
    calls.map((c) => c[0]?.id).join(",") ===
      "call_89d4a23ac097453f8f2eb192,call_5b4f3f5e78564e5eb31a8e40,call_6e1cf4e900d54b6889126e44",
    calls.map((c) => c[0]?.id).join(","),
  );
  check(
    "the original `index` is preserved on each call",
    calls.map((c) => c[0]?.index).join(",") === "0,1,2",
    calls.map((c) => c[0]?.index).join(","),
  );
  check(
    "arguments are not corrupted by the split",
    calls[1]?.[0]?.function?.arguments === '{"description": "Spawn agent beta"}',
    String(calls[1]?.[0]?.function?.arguments),
  );
  check(
    "each frame keeps the envelope (id, model, created, object)",
    frames.every(
      (f) =>
        f?.id === realGatewayFrame.id &&
        f?.model === "zai/glm-5.3-flash" &&
        f?.created === realGatewayFrame.created &&
        f?.object === "chat.completion.chunk",
    ),
  );
  check(
    "the choice index is repeated on every frame",
    frames.every((f) => f?.choices?.[0]?.index === 0),
  );
  check(
    "gateway-only keys are still stripped after the split",
    frames.every((f) => !("guardrails" in (f ?? {})) && !("routing" in (f ?? {}))),
  );
  check(
    "thinking/annotations are still stripped after the split",
    frames.every((f) => {
      const d = f?.choices?.[0]?.delta ?? {};
      return !("thinking" in d) && !("annotations" in d) && !("thinking_signature" in d);
    }),
  );

  // A single call must NOT be split or duplicated.
  const singleCall = reshapeChunks(
    {
      ...realGatewayFrame,
      choices: [
        {
          ...realGatewayFrame.choices[0],
          delta: { ...realGatewayFrame.choices[0].delta, tool_calls: [realGatewayFrame.choices[0].delta.tool_calls[0]] },
        },
      ],
    },
    "zai/glm-5.3-flash",
  );
  check("a single call is passed through as one frame", singleCall.length === 1, `got ${singleCall.length}`);

  // Ordinary content frames must be untouched.
  const contentFrame = {
    id: "x",
    object: "chat.completion.chunk",
    created: 1,
    model: "glm-5.3-flash",
    choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
  };
  const contentOut = reshapeChunks(contentFrame, "zai/glm-5.3-flash");
  check("a content frame stays one frame", contentOut.length === 1);
  check(
    "a content frame's text is unchanged",
    contentOut[0]?.choices?.[0]?.delta?.content === "hello",
  );

  // A frame that carries nothing still vanishes entirely.
  check(
    "a no-op frame yields zero frames",
    reshapeChunks({ choices: [{ index: 0, delta: { content: null }, finish_reason: null }] }).length === 0,
  );

  // Two calls, not three — the split is by count, not a fixed 3.
  const two = reshapeChunks(
    {
      ...realGatewayFrame,
      choices: [
        {
          ...realGatewayFrame.choices[0],
          delta: { ...realGatewayFrame.choices[0].delta, tool_calls: realGatewayFrame.choices[0].delta.tool_calls.slice(0, 2) },
        },
      ],
    },
    "zai/glm-5.3-flash",
  );
  check("two calls become two frames", two.length === 2, `got ${two.length}`);
  check(
    "the split preserves order for two calls",
    two.map((f) => f?.choices?.[0]?.delta?.tool_calls?.[0]?.index).join(",") === "0,1",
  );
}

console.log(failures === 0 ? "\nresponse translation: all checks passed" : `\nresponse translation: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
