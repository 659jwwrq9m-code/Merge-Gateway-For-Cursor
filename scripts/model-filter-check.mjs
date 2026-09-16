#!/usr/bin/env node
/**
 * Model-filter unit checks.
 *
 * The filter decides what a client's model picker is allowed to offer, so a bug
 * here is silent by nature: too permissive and an agent stalls on its first tool
 * call, too strict and models disappear with no explanation. These fixtures pin
 * both directions, and pin the id shape — an earlier version read only the first
 * page of the paginated catalogue and served 33 models instead of 222.
 *
 * Run with:  node scripts/model-filter-check.mjs
 */

import { readCatalog, toOpenAIModelList } from "../dist/catalog.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
};

/** Build a native-catalogue entry the way Gateway shapes one. */
const native = (model, { tool = true, access = false, provider = "openai", display } = {}) => ({
  model,
  provider,
  display_name: display ?? model,
  access_required: access,
  vendors: { somevendor: { capabilities: { supports_tool_calling: tool } } },
});

console.log("\nmodel filter checks\n");

// ---------------------------------------------------------------------------
console.log("readCatalog: membership");

check("keeps a tool-capable model", readCatalog({ data: [native("a/b")] }).length === 1);
check("drops a model with tool calling off", readCatalog({ data: [native("a/b", { tool: false })] }).length === 0);
check(
  "drops a model with no capabilities block",
  readCatalog({ data: [{ model: "a/b", vendors: { v: {} } }] }).length === 0,
);
check("drops a model with no vendors", readCatalog({ data: [{ model: "a/b", vendors: {} }] }).length === 0);
check(
  "keeps a model when any one vendor supports tools",
  readCatalog({
    data: [
      {
        model: "a/b",
        vendors: {
          off: { capabilities: { supports_tool_calling: false } },
          on: { capabilities: { supports_tool_calling: true } },
        },
      },
    ],
  }).length === 1,
  "multi-vendor: one capable vendor must be enough",
);

check("ignores entries with no model id", readCatalog({ data: [{ vendors: {} }] }).length === 0);
check("ignores non-object entries", readCatalog({ data: [null, 7, "x"] }).length === 0);

// A catalogue longer than one page must not be truncated. This is the
// regression that shipped: page 1 held 50 records, 33 of them tool-capable.
const bigPage = Array.from({ length: 289 }, (_, i) => native(`p/model-${String(i).padStart(3, "0")}`));
check("reads a full multi-page catalogue", readCatalog({ data: bigPage }).length === 289, `got ${readCatalog({ data: bigPage }).length}`);

// ---------------------------------------------------------------------------
console.log("\nreadCatalog: fields and dedup");

const one = readCatalog({ data: [native("openai/gpt-5.5", { provider: "openai", display: "GPT-5.5" })] })[0];
check("carries the display name", one?.displayName === "GPT-5.5", one?.displayName);
check("carries the provider", one?.provider === "openai", one?.provider);
check("prefixes are preserved, not stripped", one?.id === "openai/gpt-5.5", one?.id);

const gated = readCatalog({ data: [native("a/b", { access: true })] });
check("records access_required", gated[0]?.accessRequired === true);
check("defaults accessRequired to false", readCatalog({ data: [native("a/b")] })[0]?.accessRequired === false);
check(
  "a duplicate id is served once",
  readCatalog({ data: [native("a/b"), native("a/b")] }).length === 1,
);

// ---------------------------------------------------------------------------
console.log("\nreadCatalog: malformed payloads degrade to empty");

for (const [label, payload] of [
  ["null", null],
  ["a string", "nope"],
  ["an object with no data", { object: "list" }],
  ["data as an object", { data: {} }],
  ["empty data", { data: [] }],
]) {
  check(`${label} → []`, readCatalog(payload).length === 0);
}

// ---------------------------------------------------------------------------
console.log("\ntoOpenAIModelList: shape and ordering");

const catalog = [
  { id: "z/gated", displayName: "Gated", provider: "z", accessRequired: true },
  { id: "b/plain", displayName: "B", provider: "b", accessRequired: false },
  { id: "a/plain", displayName: "A", provider: "a", accessRequired: false },
];
const list = toOpenAIModelList(catalog);

check("emits the OpenAI list shape", list.every((m) => m.object === "model" && typeof m.id === "string"));
check("uses the provider as owned_by", list.find((m) => m.id === "b/plain")?.owned_by === "b");
check("created is 0, not fabricated", list.every((m) => m.created === 0));
check(
  "orders usable models alphabetically, gated last",
  list.map((m) => m.id).join(",") === "a/plain,b/plain,z/gated",
  list.map((m) => m.id).join(","),
);
check("does not mutate the input", catalog[0]?.id === "z/gated" && catalog.length === 3);
check("empty catalog → empty list", toOpenAIModelList([]).length === 0);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
