// Checks for the inbound request fixes:
//   coerceBooleanToolArgs — stringified booleans in tool-call arguments
//   applyModelAliases     — Ollama-style model ids mapped to Gateway ids
// The interrupt fixture is the literal arguments captured from a live session
// on 2026-09-17, where Cursor rejected the call with
// `interrupt: Expected boolean, received string` and the model looped.

import assert from "node:assert/strict";
import { coerceBooleanToolArgs, applyModelAliases } from "../dist/server.js";

let pass = 0;
function check(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

console.log("coerceBooleanToolArgs: the captured Task call");

// Verbatim shape from captures/2026-09-17T07-36-24-249Z-431.json (prompt
// truncated; the interrupt value is the point).
const capturedArgs = JSON.stringify({
  description: "Setup-focused admin guide section",
  interrupt: "true",
  prompt: "Your previous task was interrupted; a clarification arrived.",
});

const captured = {
  messages: [
    { role: "user", content: "resume it" },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_capture",
          type: "function",
          function: { name: "Task", arguments: capturedArgs },
        },
      ],
    },
  ],
  model: "zai/glm-5.3-flash",
};

{
  const note = coerceBooleanToolArgs(captured);
  check("returns a note when something was coerced", typeof note === "string", String(note));
  const raw = captured.messages[1].tool_calls[0].function.arguments;
  const args = JSON.parse(raw);
  check("interrupt is now a real boolean", args.interrupt === true, String(args.interrupt));
  check("arguments are still valid JSON", typeof raw === "string" && JSON.parse(raw) !== null);
  check("other keys untouched", args.description === "Setup-focused admin guide section");
  check("note names the count", note === "coerced 1 string boolean(s) in tool-call arguments", note);
}

console.log("\ncoerceBooleanToolArgs: scoping");

{
  // A prompt that legitimately contains the string "true" must not change.
  const tricky = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_tricky",
            type: "function",
            function: {
              name: "Shell",
              arguments: JSON.stringify({
                command: "echo true",
                prompt: 'pass interrupt:"true" through verbatim',
              }),
            },
          },
        ],
      },
    ],
  };
  const note = coerceBooleanToolArgs(tricky);
  check(
    "free-form keys with boolean-looking text are left alone",
    note === undefined,
    String(note),
  );
  const args = JSON.parse(tricky.messages[0].tool_calls[0].function.arguments);
  check("the string 'true' in a free-form key survives", args.prompt.includes('interrupt:"true"'));
}

{
  // Real booleans must not be rewritten (idempotent, no note).
  const already = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "c",
            type: "function",
            function: {
              name: "Task",
              arguments: JSON.stringify({ interrupt: true, run_in_background: false }),
            },
          },
        ],
      },
    ],
  };
  check("real booleans produce no note", coerceBooleanToolArgs(already) === undefined);
  const args = JSON.parse(already.messages[0].tool_calls[0].function.arguments);
  check("real booleans unchanged", args.interrupt === true && args.run_in_background === false);
}

{
  // run_in_background is the other boolean in the Task schema.
  const bg = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "c",
            type: "function",
            function: {
              name: "Task",
              arguments: JSON.stringify({ description: "d", prompt: "p", run_in_background: "false" }),
            },
          },
        ],
      },
    ],
  };
  coerceBooleanToolArgs(bg);
  const args = JSON.parse(bg.messages[0].tool_calls[0].function.arguments);
  check("run_in_background \"false\" becomes false", args.run_in_background === false);
}

{
  // A non-boolean-looking string ("1", "yes") must be left for the schema error.
  const odd = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "c",
            type: "function",
            function: { name: "Task", arguments: JSON.stringify({ interrupt: "1" }) },
          },
        ],
      },
    ],
  };
  check("non true/false strings untouched", coerceBooleanToolArgs(odd) === undefined);
  check("value still the string", JSON.parse(odd.messages[0].tool_calls[0].function.arguments).interrupt === "1");
}

{
  // Malformed arguments JSON must survive byte-for-byte.
  const broken = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "c",
            type: "function",
            function: { name: "Task", arguments: '{"interrupt":"true"' },
          },
        ],
      },
    ],
  };
  check("malformed JSON produces no note", coerceBooleanToolArgs(broken) === undefined);
  check("malformed JSON untouched", broken.messages[0].tool_calls[0].function.arguments === '{"interrupt":"true"');
}

{
  // Multiple calls in one message: one coerced, one clean.
  const multi = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "Task", arguments: JSON.stringify({ interrupt: "true" }) },
          },
          {
            id: "b",
            type: "function",
            function: { name: "Read", arguments: JSON.stringify({ path: "/x" }) },
          },
        ],
      },
    ],
  };
  const note = coerceBooleanToolArgs(multi);
  check("mixed calls: note present", typeof note === "string");
  check(
    "mixed calls: count is 1",
    note === "coerced 1 string boolean(s) in tool-call arguments",
    note,
  );
}

{
  // Responses-dialect bodies (input, not messages) are out of scope and safe.
  check("input-shaped body is a no-op", coerceBooleanToolArgs({ input: [] }) === undefined);
  check("null body is a no-op", coerceBooleanToolArgs(null) === undefined);
  check("string body is a no-op", coerceBooleanToolArgs("nope") === undefined);
}

console.log("\napplyModelAliases");

{
  const body = { model: "glm-5.3-flash:cloud", messages: [] };
  const note = applyModelAliases(body);
  check("ollama name rewritten", body.model === "zai/glm-5.3-flash", String(body.model));
  check("note records the mapping", note === "model alias: glm-5.3-flash:cloud -> zai/glm-5.3-flash", note);
}

{
  const body = { model: "zai/glm-5.3-flash", messages: [] };
  const note = applyModelAliases(body);
  check("gateway id passes through untouched", body.model === "zai/glm-5.3-flash");
  check("gateway id produces no note", note === undefined);
}

{
  const body = { model: "unknown-model:cloud", messages: [] };
  applyModelAliases(body);
  check("unknown ids are not guessed", body.model === "unknown-model:cloud");
}

{
  check("no model is a no-op", applyModelAliases({ messages: [] }) === undefined);
  check("null body is a no-op", applyModelAliases(null) === undefined);
}

console.log(`\nargs check: ${pass} passed${process.exitCode ? " (with failures)" : ""}`);
if (!process.exitCode) console.log("all checks passed");
