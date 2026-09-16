#!/usr/bin/env node
/**
 * Model-filter unit checks.
 *
 * The filter decides what a client's model picker is allowed to offer, so a bug
 * here is silent by nature: too permissive and an agent stalls on its first tool
 * call, too strict and models disappear with no explanation. These fixtures pin
 * both directions.
 *
 * Run with:  node scripts/model-filter-check.mjs
 */

import { readToolCapable, orderForPicker } from "../dist/catalog.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
};

/** Build a native-catalogue entry the way Gateway shapes one. */
const native = (model, { tool = true, access = false, vendors = ["bedrock"] } = {}) => ({
  model,
  access_required: access,
  vendors: Object.fromEntries(
    vendors.map((name) => [name, { capabilities: { supports_tool_calling: tool } }]),
  ),
});

console.log("\nmodel filter checks\n");

// ---------------------------------------------------------------------------
console.log("readToolCapable: membership");

check("keeps a tool-capable model", readToolCapable({ data: [native("a/b")] }).length === 1);
check("drops a model with tool calling off", readToolCapable({ data: [native("a/b", { tool: false })] }).length === 0);

check(
  "drops a model with no capabilities block",
  readToolCapable({ data: [{ model: "a/b", vendors: { bedrock: {} } }] }).length === 0,
);
check(
  "drops a model with no vendors",
  readToolCapable({ data: [{ model: "a/b", vendors: {} }] }).length === 0,
);
check(
  "keeps a model when any one vendor supports tools",
  readToolCapable({
    data: [native("a/b", { tool: false, vendors: ["bedrock"] })].map((m) => ({
      ...m,
      vendors: {
        bedrock: { capabilities: { supports_tool_calling: false } },
        other: { capabilities: { supports_tool_calling: true } },
      },
    })),
  }).length === 1,
  "multi-vendor: one capable vendor must be enough",
);

check("ignores entries with no model id", readToolCapable({ data: [{ vendors: {} }] }).length === 0);
check("ignores non-object entries", readToolCapable({ data: [null, 7, "x"] }).length === 0);

// ---------------------------------------------------------------------------
console.log("\nreadToolCapable: access flag");

const gated = readToolCapable({ data: [native("a/b", { access: true })] });
check("records access_required", gated[0]?.accessRequired === true);
const open = readToolCapable({ data: [native("a/b")] });
check("defaults accessRequired to false", open[0]?.accessRequired === false);

// ---------------------------------------------------------------------------
console.log("\nreadToolCapable: malformed payloads degrade to empty");

for (const [label, payload] of [
  ["null", null],
  ["a string", "nope"],
  ["an object with no data", { object: "list" }],
  ["data as an object", { data: {} }],
  ["empty data", { data: [] }],
]) {
  check(`${label} → []`, readToolCapable(payload).length === 0);
}

// ---------------------------------------------------------------------------
console.log("\norderForPicker: filtering and ordering");

const catalog = [
  { id: "z/gated", accessRequired: true },
  { id: "b/plain", accessRequired: false },
  { id: "a/plain", accessRequired: false },
];
const surface = [
  { id: "z/gated", object: "model", created: 1, owned_by: "g" },
  { id: "not-capable", object: "model", created: 1, owned_by: "g" },
  { id: "b/plain", object: "model", created: 1, owned_by: "g" },
  { id: "a/plain", object: "model", created: 1, owned_by: "g" },
];

const ordered = orderForPicker(surface, catalog);
check("drops models missing from the catalog", !ordered.some((m) => m.id === "not-capable"));
check("keeps every catalogued model", ordered.length === 3, `got ${ordered.length}`);
check(
  "orders usable models alphabetically, gated last",
  ordered.map((m) => m.id).join(",") === "a/plain,b/plain,z/gated",
  ordered.map((m) => m.id).join(","),
);
check(
  "preserves the original entry fields",
  ordered[0]?.object === "model" && ordered[0]?.owned_by === "g",
);

check("empty catalog drops everything", orderForPicker(surface, []).length === 0);
check("does not mutate the input list", surface.length === 4);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
