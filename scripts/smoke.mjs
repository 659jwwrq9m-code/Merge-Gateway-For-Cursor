#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Boots the shim on an ephemeral port and posts the payload shapes Cursor is
 * known to send in Agent mode, then asserts the shim classified them correctly,
 * translated them, and answered in the shape Cursor's parser expects.
 *
 * Run with:  node scripts/smoke.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "index.js");

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const captureDir = mkdtempSync(join(tmpdir(), "shim-capture-"));

let failures = 0;
const check = (label, ok, detail = "") => {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`  ${mark}  ${label}${detail && !ok ? ` — ${detail}` : ""}`);
};

/** Wait until /health answers, so tests do not race the listener. */
async function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Payloads, modelled on real captured Cursor Agent traffic
// ---------------------------------------------------------------------------

/** The documented Agent-mode case: Responses body, Chat Completions path. */
const responsesShaped = {
  model: "anthropic/claude-opus-5",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "list the files" }] },
    { type: "function_call", call_id: "call_a", name: "read_file", arguments: '{"path":"a.txt"}' },
    { type: "function_call_output", call_id: "call_a", output: "hello" },
  ],
  instructions: "You are a coding agent.",
  stream: true,
  include: ["reasoning.encrypted_content"],
  reasoning: { effort: "medium", summary: "auto" },
  text: { verbosity: "low" },
  stream_options: { include_usage: true },
  tools: [
    {
      type: "function",
      name: "read_file",
      description: "Read a file from disk",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    { type: "custom", name: "ApplyPatch", format: { type: "grammar", grammar: "start: patch" } },
  ],
};

/** The mixed case: Chat top level, one stray Responses-only custom tool. */
const mixedShaped = {
  model: "anthropic/claude-opus-5",
  messages: [{ role: "user", content: "edit the file" }],
  stream: true,
  tools: [
    { type: "function", function: { name: "edit_file", parameters: { type: "object" } } },
    { type: "custom", name: "ApplyPatch", format: { type: "grammar", grammar: "start: patch" } },
  ],
  stream_options: { include_usage: true },
};

/** Flat Responses tools only, with no custom tool to muddy the classification. */
const flatToolsShaped = {
  model: "anthropic/claude-opus-5",
  input: [{ type: "message", role: "user", content: "read a file" }],
  stream: false,
  tools: [
    { type: "function", name: "read_file", parameters: { type: "object", properties: {} } },
    { type: "function", name: "list_dir", parameters: { type: "object", properties: {} } },
  ],
};

/** The clean case, which must survive translation untouched. */
const chatShaped = {
  model: "anthropic/claude-opus-5",
  messages: [{ role: "user", content: "hello" }],
  stream: false,
};

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nshim smoke test (capture dir: ${captureDir})\n`);

  const child = spawn(process.execPath, [entry, "--port", String(PORT), "--capture-dir", captureDir], {
    cwd: root,
    env: { ...process.env, SHIM_PASSTHROUGH: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  child.stderr.on("data", (d) => logs.push(d.toString()));

  try {
    if (!(await waitForServer())) throw new Error("shim did not start");

    // --- health -----------------------------------------------------------
    console.log("health");
    const health = await fetch(`${BASE}/health`);
    const healthBody = await health.json();
    check("GET /health returns ok", health.ok && healthBody.status === "ok");
    check("reports capture mode", healthBody.mode === "capture", JSON.stringify(healthBody));

    // --- models -----------------------------------------------------------
    console.log("\nmodels");
    const models = await (await fetch(`${BASE}/v1/models`)).json();
    check("GET /v1/models lists a model", Array.isArray(models.data) && models.data.length > 0);

    // --- responses-shaped request ----------------------------------------
    console.log("\nresponses-shaped body → /v1/chat/completions");
    let res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer placeholder" },
      body: JSON.stringify(responsesShaped),
    });
    check("accepted (200)", res.status === 200, `got ${res.status}`);
    check("replied as SSE", (res.headers.get("content-type") ?? "").includes("text/event-stream"));
    const sse = await res.text();
    check("SSE has delta content", sse.includes('"delta"') && sse.includes("content"));
    check("SSE terminates with [DONE]", sse.includes("data: [DONE]"));
    check("SSE uses choices[].finish_reason", sse.includes("finish_reason"));

    // --- flat Responses tools ---------------------------------------------
    console.log("\nresponses body with flat function tools only");
    res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(flatToolsShaped),
    });
    check("accepted (200)", res.status === 200, `got ${res.status}`);
    await res.text();

    // --- mixed body -------------------------------------------------------
    console.log("\nmixed body (Chat top level + custom tool)");
    res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mixedShaped),
    });
    check("accepted (200)", res.status === 200, `got ${res.status}`);
    await res.text();

    // --- clean chat request ----------------------------------------------
    console.log("\nclean chat body, non-streaming");
    res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatShaped),
    });
    const json = await res.json();
    check("accepted (200)", res.status === 200, `got ${res.status}`);
    check("returned chat.completion object", json.object === "chat.completion", json.object);
    check("has choices[0].message", Boolean(json.choices?.[0]?.message));

    // --- error paths ------------------------------------------------------
    console.log("\nerror handling");
    res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    check("malformed JSON → 400", res.status === 400, `got ${res.status}`);

    res = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(responsesShaped),
    });
    const notImpl = await res.json();
    check("POST /v1/responses → 501 with guidance", res.status === 501, `got ${res.status}`);
    check(
      "501 message names the right base URL",
      /chat\/completions/.test(notImpl.error?.message ?? ""),
      notImpl.error?.message,
    );

    // --- capture ----------------------------------------------------------
    console.log("\ncaptures");
    const files = readdirSync(captureDir).filter((f) => f.endsWith(".json"));
    check("wrote one capture per request", files.length === 5, `found ${files.length}`);

    const indexLines = readFileSync(join(captureDir, "index.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    check("index has a line per request", indexLines.length === 5, `found ${indexLines.length}`);

    const first = indexLines[0];
    check("detected responses dialect", first.kind === "responses", first.kind);
    check("detected mixed tool format", first.tools === "mixed", first.tools);
    check("recorded custom tool name", first.customTools?.includes("ApplyPatch"), JSON.stringify(first.customTools));
    check("recorded Responses-only fields", first.responsesOnly?.includes("input"), JSON.stringify(first.responsesOnly));

    const flat = indexLines[1];
    check("detected flat tool format", flat.tools === "flat", flat.tools);

    const mixed = indexLines[2];
    check("detected mixed dialect", mixed.kind === "mixed", mixed.kind);

    const clean = indexLines[3];
    check("detected clean chat dialect", clean.kind === "chat_completions", clean.kind);

    const malformed = indexLines[4];
    check("recorded the malformed body as unknown", malformed.kind === "unknown", malformed.kind);

    // Credentials must never land on disk.
    const raw = readFileSync(join(captureDir, files[0]), "utf8");
    check("capture redacts the auth header", !raw.includes("placeholder"), "found raw credential");
    check("capture still notes the auth scheme", /Bearer\s•+/.test(raw), "no redaction marker");

    const captured = JSON.parse(raw);
    check("capture keeps the original body", captured.body?.input !== undefined);
    check("capture records request headers", Boolean(captured.headers?.["content-type"]));
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
  if (failures > 0) {
    console.log("\n--- shim stderr ---");
    console.log(logs.join(""));
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`smoke test error: ${error.message}`);
  process.exit(1);
});
