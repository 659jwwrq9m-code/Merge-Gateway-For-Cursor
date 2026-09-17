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

  // ---------------------------------------------------------------------------
  console.log("\ncontext limits: min across vendors");

  /**
   * A model served by several vendors with differing windows. The advertised
   * number must be the *smallest*, because Gateway picks a vendor per request:
   * promising the largest would let a client build a prompt that the routed
   * vendor then rejects.
   */
  const multiVendor = (contexts) => ({
    data: [
      {
        model: "v/multi",
        provider: "v",
        display_name: "Multi",
        access_required: false,
        vendors: Object.fromEntries(
          contexts.map((ctx, i) => [
            `vendor${i}`,
            {
              capabilities: { supports_tool_calling: true },
              context_window: ctx.context,
              max_output_tokens: ctx.output,
            },
          ]),
        ),
      },
    ],
  });

  const ctxOf = (payload) => readCatalog(payload)[0]?.contextLength;
  const outOf = (payload) => readCatalog(payload)[0]?.maxOutputTokens;

  check(
    "takes the minimum window, not the maximum",
    ctxOf(multiVendor([{ context: 1048576, output: 131072 }, { context: 1000000, output: 131000 }])) === 1000000,
    String(ctxOf(multiVendor([{ context: 1048576, output: 131072 }, { context: 1000000, output: 131000 }]))),
  );
  check(
    "takes the minimum max_output_tokens",
    outOf(multiVendor([{ context: 1000000, output: 131072 }, { context: 1000000, output: 131000 }])) === 131000,
  );
  check(
    "the anthropic/bedrock case: 1M vs 200k → 200k",
    ctxOf(multiVendor([{ context: 1000000, output: 64000 }, { context: 200000, output: 64000 }])) === 200000,
  );
  check(
    "a single vendor's window is used as-is",
    ctxOf(multiVendor([{ context: 262144, output: 131072 }])) === 262144,
  );
  check(
    "null windows are treated as absent, not as 0",
    ctxOf(multiVendor([{ context: null, output: null }, { context: 200000, output: 64000 }])) === 200000,
  );
  check(
    "a 0 window is ignored rather than winning the minimum",
    ctxOf(multiVendor([{ context: 0, output: 0 }, { context: 200000, output: 64000 }])) === 200000,
  );
  check(
    "no vendor publishes a window → field omitted, not zero",
    ctxOf(multiVendor([{ context: null, output: null }])) === undefined,
  );
  check(
    "a non-tool-capable vendor still contributes its window",
    ctxOf({
      data: [
        {
          model: "v/mixed",
          provider: "v",
          access_required: false,
          vendors: {
            nocap: { capabilities: { supports_tool_calling: false }, context_window: 100000 },
            cap: { capabilities: { supports_tool_calling: true }, context_window: 200000 },
          },
        },
      ],
    }) === 100000,
  );

  // ---------------------------------------------------------------------------
  console.log("\ntoOpenAIModelList: limit rendering");

  const rendered = toOpenAIModelList([
    { id: "a/limited", displayName: "A", provider: "a", accessRequired: false, contextLength: 1000000, maxOutputTokens: 131000 },
    { id: "b/unknown", displayName: "B", provider: "b", accessRequired: false },
  ]);
  const limited = rendered.find((m) => m.id === "a/limited");
  const unknown = rendered.find((m) => m.id === "b/unknown");

  check("renders context_length", limited?.context_length === 1000000);
  check("renders max_output_tokens", limited?.max_output_tokens === 131000);
  check(
    "a model with no window keeps the original four-key shape",
    JSON.stringify(Object.keys(unknown ?? {}).sort()) ===
      JSON.stringify(["created", "id", "object", "owned_by"]),
    JSON.stringify(Object.keys(unknown ?? {})),
  );
  check(
    "no `undefined` survives serialisation",
    !JSON.stringify(rendered).includes("undefined"),
  );
  check(
    "the OpenAI quartet is still intact on a limited model",
    limited?.object === "model" && limited?.created === 0 && limited?.owned_by === "a",
  );

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
