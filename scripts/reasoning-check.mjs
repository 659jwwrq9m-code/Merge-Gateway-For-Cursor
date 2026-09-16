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

import { disableUnpreservableReasoning, requiresReasoningEcho } from "../dist/server.js";

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
  const body = { model: "deepseek/deepseek-v4.1-flash", messages: toolTurn().messages, reasoning_effort: "high" };
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
  const body = { model: "deepseek/deepseek-v4.1-flash", messages: toolTurn().messages, reasoning_effort: "none" };
  check(
    "already-none is a no-op",
    disableUnpreservableReasoning(body, config) === undefined && body.reasoning_effort === "none",
  );
}

// The rewrite is not free: it suppresses reasoning the provider would otherwise
// have produced, and in an agent loop nearly every turn returns tool results.
// Applying it to every model made reasoning vanish for models that never needed
// it, so it is scoped to the providers that actually demand the echo.
console.log("\nonly providers that require the echo are rewritten");
{
  const glm = { model: "zai/glm-5.3-flash", messages: toolTurn().messages };
  check(
    "glm tool turn keeps its reasoning",
    disableUnpreservableReasoning(glm, config) === undefined && glm.reasoning_effort === undefined,
  );

  const anthropic = { model: "anthropic/claude-opus-5", messages: toolTurn().messages };
  check(
    "anthropic tool turn keeps its reasoning",
    disableUnpreservableReasoning(anthropic, config) === undefined && anthropic.reasoning_effort === undefined,
  );

  const unknown = { model: "someone/new-model", messages: toolTurn().messages };
  check(
    "an unrecognised model keeps its reasoning",
    disableUnpreservableReasoning(unknown, config) === undefined && unknown.reasoning_effort === undefined,
  );

  const noModel = { messages: toolTurn().messages };
  check(
    "a request with no model keeps its reasoning",
    disableUnpreservableReasoning(noModel, config) === undefined && noModel.reasoning_effort === undefined,
  );

  check("deepseek is recognised", requiresReasoningEcho("deepseek/deepseek-v4.1-flash") !== undefined);
  check("deepseek is recognised case-insensitively", requiresReasoningEcho("DeepSeek/DeepSeek-V4-Pro") !== undefined);
  check("glm is not recognised", requiresReasoningEcho("zai/glm-5.3-flash") === undefined);
  check("non-string model is not recognised", requiresReasoningEcho(null) === undefined);

  // The DeepSeek path must still fire, or the original loop returns.
  const deepseek = { model: "deepseek/deepseek-v4.1-flash", messages: toolTurn().messages };
  check(
    "deepseek tool turn is still rewritten",
    disableUnpreservableReasoning(deepseek, config) !== undefined && deepseek.reasoning_effort === "none",
  );
}

console.log("\nmalformed bodies are ignored rather than thrown on");
for (const [label, body] of [
  ["null", null],
  ["a string", "nope"],
  ["no messages", { model: "deepseek/x" }],
  ["messages not an array", { model: "deepseek/x", messages: {} }],
  ["null message entries", { model: "deepseek/x", messages: [null, 7] }],
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
    model: "deepseek/x",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  };
  check("no tool role → no rewrite", disableUnpreservableReasoning(body, config) === undefined);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
