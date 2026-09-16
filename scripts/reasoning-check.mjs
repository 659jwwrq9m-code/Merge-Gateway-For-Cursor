#!/usr/bin/env node
/**
 * Reasoning-compatibility checks.
 *
 * This is the guard for the bug that made Agent mode loop forever. Providers
 * such as DeepSeek's thinking mode reject the follow-up turn of a tool
 * conversation unless the previous turn's `reasoning_content` is echoed back
 * verbatim, and agent clients do not preserve it — so the turn 400s, the client
 * retries the same conversation, and the UI shows "reconnecting" indefinitely.
 *
 * Measured against Gateway directly: sending a fabricated `reasoning_content`
 * does NOT satisfy the provider, while `reasoning_effort: "none"` does. These
 * assertions pin the rewrite, including the cases where it must NOT fire.
 *
 * Run with:  node scripts/reasoning-check.mjs
 */

import { disableUnpreservableReasoning } from "../dist/server.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
};

const config = { forceToolReasoningOff: true };
const off = { forceToolReasoningOff: false };

/** A conversation whose last turn returns tool results — the at-risk shape. */
const toolTurn = () => ({
  model: "deepseek/deepseek-v4.1-flash",
  messages: [
    { role: "user", content: "list files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "Shell", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", content: "README.md" },
  ],
});

console.log("\nreasoning compatibility checks\n");

console.log("rewrite fires on a tool-result turn");
{
  const body = toolTurn();
  const note = disableUnpreservableReasoning(body, config);
  check("returns an explanatory note", typeof note === "string");
  check("sets reasoning_effort to none", body.reasoning_effort === "none", String(body.reasoning_effort));
}

console.log("\nit is inert where it must be");
{
  const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
  check("plain chat turn untouched", disableUnpreservableReasoning(body, config) === undefined);
  check("no reasoning_effort injected", body.reasoning_effort === undefined);
}
{
  const body = { model: "m", messages: toolTurn().messages, reasoning_effort: "high" };
  check(
    "a caller's explicit reasoning_effort is respected",
    disableUnpreservableReasoning(body, config) === undefined && body.reasoning_effort === "high",
  );
}
{
  const body = toolTurn();
  check("disabled by config", disableUnpreservableReasoning(body, off) === undefined);
  check("and leaves the body alone", body.reasoning_effort === undefined);
}
{
  const body = { model: "m", messages: toolTurn().messages, reasoning_effort: "none" };
  check(
    "already-none is a no-op",
    disableUnpreservableReasoning(body, config) === undefined && body.reasoning_effort === "none",
  );
}

console.log("\nmalformed bodies are ignored rather than thrown on");
for (const [label, body] of [
  ["null", null],
  ["a string", "nope"],
  ["no messages", { model: "m" }],
  ["messages not an array", { model: "m", messages: {} }],
  ["null message entries", { model: "m", messages: [null, 7] }],
]) {
  let threw = false;
  let result;
  try {
    result = disableUnpreservableReasoning(body, config);
  } catch {
    threw = true;
  }
  check(`${label} → undefined, no throw`, threw === false && result === undefined, threw ? "threw" : "");
}

console.log("\nassistant-only history is left alone");
{
  const body = {
    model: "m",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  };
  check("no tool role → no rewrite", disableUnpreservableReasoning(body, config) === undefined);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
