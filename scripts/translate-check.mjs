#!/usr/bin/env node
/**
 * Translation unit checks.
 *
 * Exercises `toChatCompletions` directly against payloads modelled on real
 * Cursor Agent traffic. These are the assertions that matter most for the
 * eventual fix, because a translation bug here shows up in Cursor as a silent
 * failure to apply edits rather than an obvious error.
 *
 * Run with:  node scripts/translate-check.mjs
 */

import { toChatCompletions } from "../dist/translate.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
};

const toolNames = (body) =>
  (body.tools ?? []).map((t) => t.function?.name).filter(Boolean);

console.log("\ntranslation checks\n");

// ---------------------------------------------------------------------------
console.log("responses body → chat completions");

const responses = {
  model: "anthropic/claude-opus-5",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
    { type: "function_call", call_id: "call_a", name: "read_file", arguments: '{"path":"a.txt"}' },
    { type: "function_call_output", call_id: "call_a", output: "file contents" },
  ],
  instructions: "You are a coding agent.",
  stream: true,
  include: ["reasoning.encrypted_content"],
  reasoning: { effort: "medium", summary: "auto" },
  text: { format: { type: "json_object" } },
  max_output_tokens: 4096,
  store: true,
  stream_options: { include_usage: true },
  tools: [
    { type: "function", name: "read_file", parameters: { type: "object" } },
    { type: "custom", name: "ApplyPatch", format: { type: "grammar", grammar: "start: patch" } },
  ],
};

const a = toChatCompletions(responses);

check("instructions became a leading system message", a.body.messages[0]?.role === "system", a.body.messages[0]?.role);
check("input text was flattened to a string", a.body.messages[1]?.content === "list files", JSON.stringify(a.body.messages[1]?.content));
check("function_call became an assistant tool_calls entry", Array.isArray(a.body.messages[2]?.tool_calls), JSON.stringify(a.body.messages[2]));
check("tool call id was preserved", a.body.messages[2]?.tool_calls?.[0]?.id === "call_a");
check("function_call_output became a tool message", a.body.messages[3]?.role === "tool", a.body.messages[3]?.role);
check("tool result is linked by tool_call_id", a.body.messages[3]?.tool_call_id === "call_a");
check("flat tool was nested under function", Boolean(a.body.tools?.[0]?.function), JSON.stringify(a.body.tools?.[0]));
check("custom tool was promoted to a function", toolNames(a.body).includes("ApplyPatch"), toolNames(a.body).join(","));
check("custom tool exposes a free-form input param", a.body.tools?.[1]?.function?.parameters?.properties?.input?.type === "string");
check("reasoning.effort mapped to reasoning_effort", a.body.reasoning_effort === "medium", String(a.body.reasoning_effort));
check("text.format mapped to response_format", a.body.response_format?.type === "json_object", JSON.stringify(a.body.response_format));
check("max_output_tokens mapped to max_tokens", a.body.max_tokens === 4096, String(a.body.max_tokens));
check("input was dropped", a.body.input === undefined);
check("instructions were dropped", a.body.instructions === undefined);
check("store was dropped", a.body.store === undefined);
check("include was dropped", a.body.include === undefined);
check("stream_options was dropped", a.body.stream_options === undefined);
check("reasoning object was dropped", a.body.reasoning === undefined);
check("stream flag survived", a.body.stream === true);
check("model survived", a.body.model === "anthropic/claude-opus-5");
check("no Responses-only field leaked through", !("input" in a.body) && !("text" in a.body));

// ---------------------------------------------------------------------------
console.log("\nidempotence");

const chat = {
  model: "anthropic/claude-opus-5",
  messages: [{ role: "user", content: "hello" }],
  tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  max_tokens: 100,
  stream: false,
};
const b = toChatCompletions(chat);
check("already-nested tools pass through untouched", b.body.tools?.[0]?.function?.name === "read_file");
check("messages survive unchanged", b.body.messages?.[0]?.content === "hello");
check("max_tokens survives", b.body.max_tokens === 100);
check("re-translating is stable", JSON.stringify(toChatCompletions(b.body).body.tools) === JSON.stringify(b.body.tools));

// ---------------------------------------------------------------------------
console.log("\nedge cases");

const stringInput = toChatCompletions({ model: "m", input: "just a string" });
check("string input becomes a user message", stringInput.body.messages?.[0]?.content === "just a string", JSON.stringify(stringInput.body.messages));

const empty = toChatCompletions({ model: "m" });
check("empty body yields a valid message array", Array.isArray(empty.body.messages) && empty.body.messages.length > 0);

const image = toChatCompletions({
  model: "m",
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: "what is this" },
        { type: "input_image", image_url: "https://example.com/a.png" },
      ],
    },
  ],
});
check("image content stays a part array", Array.isArray(image.body.messages?.[0]?.content), JSON.stringify(image.body.messages?.[0]?.content));
check("image url was mapped", image.body.messages?.[0]?.content?.[1]?.image_url?.url === "https://example.com/a.png");

const developer = toChatCompletions({ model: "m", input: [{ role: "developer", content: "be terse" }] });
check("developer role mapped to system", developer.body.messages?.[0]?.role === "system", developer.body.messages?.[0]?.role);

const reasoningOnly = toChatCompletions({ model: "m", input: [{ type: "reasoning", summary: [] }, { role: "user", content: "hi" }] });
check("reasoning items are skipped", reasoningOnly.body.messages?.length === 1, JSON.stringify(reasoningOnly.body.messages));

const webSearch = toChatCompletions({ model: "m", messages: [{ role: "user", content: "x" }], tools: [{ type: "web_search" }] });
check("unsupported web_search tool is dropped", webSearch.body.tools === undefined, JSON.stringify(webSearch.body.tools));

const nullContent = toChatCompletions({ model: "m", input: [{ type: "function_call", call_id: "c", name: "f" }] });
check("tool call with null content is valid", nullContent.body.messages?.[0]?.content === null, JSON.stringify(nullContent.body.messages?.[0]));

console.log(`\n${failures === 0 ? "all translation checks passed" : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
