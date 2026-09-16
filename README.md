# merge-gateway-shim

A small local proxy that lets **Cursor's Agent mode** route through
**[Merge Gateway](https://docs.merge.dev/merge-gateway/get-started)**.

Merge's own docs describe the problem this solves:

> Cursor's Agent mode does not currently support custom API keys. Only Ask and
> Plan modes work with a custom OpenAI base URL. […] This is a Cursor-side
> restriction; Gateway itself handles agentic workloads fine.

The restriction is a wire-format mismatch inside Cursor's BYOK path, and it is
fixable from the outside.

## The problem

When Cursor is pointed at a custom OpenAI base URL, its Agent mode is
self-inconsistent about dialects:

| Layer | What Cursor uses |
| --- | --- |
| Request path | `POST {base}/chat/completions` |
| Request body | **Responses** shape — `input[]`, flat `tools[]`, `reasoning`, `text`, `include`, `store` |
| Response parser | **Chat Completions** SSE — `choices[].delta`, `finish_reason` |

So it asks in one dialect and expects the answer in another. Three consequences:

- A strict Chat Completions upstream rejects the body with
  `Missing required parameter: 'messages'`.
- `stream_options: {include_usage: true}` is sent, which is a Chat
  Completions-only field the Responses API rejects.
- Tools arrive as `{"type":"custom","name":"ApplyPatch","format":{"type":"grammar",…}}`
  — a Responses-only shape with no Chat Completions equivalent. This one
  specifically breaks **file edits** while chat keeps working, which is the
  "the agent replies but never applies changes" symptom.

There is also an unrelated Cursor bug where a custom model id colliding with a
catalog name gets rewritten before it leaves (`glm-5.2` → `glm-5.2-high`), which
matters because Gateway ids are `provider/model`.

Cursor sometimes mixes shapes in a single request: a Chat Completions top level
carrying one stray `type:"custom"` tool.

## The fix

```
Cursor (Agent mode)
   │  POST /v1/chat/completions        body: Responses-shaped
   ▼
merge-gateway-shim  (localhost:8787)
   │  1. classify the body
   │  2. capture it to disk (credentials redacted)
   │  3. normalise → strict Chat Completions
   ▼
Merge Gateway   /v1/openai/chat/completions
   │  standard OpenAI SSE
   ▼
merge-gateway-shim
   │  4. pass SSE straight back, no buffering
   ▼
Cursor  ✓ renders, calls tools, applies edits
```

Normalising **down** to Chat Completions is deliberate: Gateway's OpenAI surface
is its best-tested path, so routing, failover, budgets, and cost attribution all
keep working, and the response side needs no translation at all.

Gateway already exposes both dialects, so nothing is needed from Merge:

```
POST /v1/openai/chat/completions   native OpenAI surface   ← the shim targets this
POST /v1/openai/responses          OpenAI-shaped Responses
POST /v1/responses                 Gateway-native Responses
```

## Requirements

- Node.js 20.12+ (uses `process.loadEnvFile`; older runtimes fall back to a
  built-in parser)
- A Merge Gateway API key from [dashboard.merge.dev](https://dashboard.merge.dev)

## Setup

```sh
cp .env.example .env
```

Put your key in `.env`:

```ini
MERGE_GATEWAY_API_KEY=your_key_here
```

Then verify it:

```sh
npm run check:env
```

```
shim resolved configuration
  .env                /path/to/merge-gateway-shim/.env
  applied from .env   MERGE_GATEWAY_API_KEY
  gateway base url    https://api-gateway.merge.dev/v1/openai
  api key             mg_abc…9xyz (35 chars)
  listen              http://127.0.0.1:8787/v1
  mode                capture only (no upstream calls)
  capture dir         /path/to/merge-gateway-shim/captures
  cursor base url     http://127.0.0.1:8787/v1

shim verifying key against Gateway…
shim ✓ key accepted, 214 model(s) visible
```

`--check` needs no running server and spends no tokens: it calls
`GET /models`, which is authenticated but free, so it is real proof the key works
rather than just a format check.

### Environment precedence

Highest wins:

1. Command-line flags — `--port`, `--gateway-url`, …
2. Variables already in your shell
3. `.env` beside this project
4. Built-in defaults

`.env` sits *below* the ambient environment on purpose, so a key exported for one
run wins without editing the file:

```sh
MERGE_GATEWAY_API_KEY=mg_other_key npm start
```

`--check` reports which source each variable came from (`applied from .env` vs
`already in shell (shell wins)`), and the key is always masked.

## Step 1 — survey Cursor's traffic

**Capture mode is the default.** The shim records every request and answers
locally without ever contacting Gateway, so you can survey traffic without
spending anything.

```sh
npm start
```

Captures land in `captures/`, one full JSON per request plus a compact
`index.jsonl` you can read at a glance:

```sh
cat captures/index.jsonl
```

```json
{"seq":1,"method":"POST","path":"/v1/chat/completions","model":"anthropic/claude-opus-5",
 "kind":"responses","tools":"mixed","toolCount":2,"customTools":["ApplyPatch"],
 "stream":true,"responsesOnly":["input","instructions","include","reasoning","text"],"bytes":812}
```

That single line answers the questions this project exists to settle: which path
Cursor used, which dialect it sent, how the tools were shaped, and whether the
`ApplyPatch` custom tool is present.

Credentials are redacted on write — `Authorization: Bearer ••••`, keeping the
scheme so a capture still shows *how* auth was sent. Captures are safe to share.

Point Cursor at it:

1. **Settings → Cursor Settings → Models**
2. Enable **OpenAI API Key** — any placeholder works; the shim holds the real key
3. Enable **Override OpenAI Base URL** → `http://127.0.0.1:8787/v1`
4. **+ Add Custom Model** → `anthropic/claude-opus-5` (or any Gateway id)
5. Send a message in **Agent mode**

If you get connection errors, set **Settings → Network → HTTP Compatibility Mode**
to **HTTP/1.1**. Cursor defaults to HTTP/2 and many local proxies do not serve it.

## Step 2 — turn on passthrough

Once you have a capture, forward to Gateway:

```sh
SHIM_PASSTHROUGH=1 npm start
```

Or in `.env`:

```ini
SHIM_PASSTHROUGH=1
```

Passthrough is off by default specifically so that capture mode cannot spend
money. The shim logs when it is billing:

```
shim listening on http://127.0.0.1:8787/v1 · passthrough → Gateway
shim passthrough is on: requests will be forwarded to Gateway and billed.
```

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERGE_GATEWAY_API_KEY` | — | Gateway key. Required for passthrough |
| `MERGE_GATEWAY_BASE_URL` | `https://api-gateway.merge.dev/v1/openai` | Gateway's OpenAI surface |
| `MERGE_GATEWAY_PROJECT_ID` | — | Sent as `X-Merge-Project-Id` to attribute cost and apply that project's routing policy |
| `SHIM_HOST` | `127.0.0.1` | Bind address |
| `SHIM_PORT` | `8787` | Listen port |
| `SHIM_MODEL` | — | Fallback model id when Cursor sends none |
| `SHIM_CAPTURE_DIR` | `captures` | Where captures are written |
| `SHIM_CAPTURE` | `1` | Write captures to disk |
| `SHIM_PASSTHROUGH` | `0` | Forward to Gateway |
| `SHIM_MAX_BODY_BYTES` | `67108864` | Request body cap (or `SHIM_MAX_BODY_MB`) |
| `SHIM_QUIET` | `0` | Suppress per-request lines |
| `SHIM_DEBUG` | — | Verbose translation diagnostics |

Run `node dist/index.js --help` for the flag equivalents.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | The endpoint Cursor uses |
| `GET` | `/v1/models` | Model list — passthrough to Gateway, or a minimal stub |
| `GET` | `/health` | Liveness, and which mode is active |
| `POST` | `/v1/responses` | Returns `501` with guidance rather than a mismatched body |

The `/v1/responses` refusal is deliberate. A client posting there expects a
Responses-shaped reply, and answering with a Chat Completions body would surface
as a mysterious parse failure further down. A clear `501` naming the right base
URL is easier to debug.

## How the translation works

`src/translate.ts`, all pure and synchronous:

| Responses | Chat Completions |
| --- | --- |
| `input[]` | `messages[]` |
| `instructions` | leading `system` message |
| `function_call` / `function_call_output` | `assistant.tool_calls` / `role:"tool"` |
| `{"type":"function","name":…}` | `{"type":"function","function":{…}}` |
| `{"type":"custom","name":"ApplyPatch",…}` | free-form function with a single `input` string |
| `role:"developer"` | `role:"system"` |
| `reasoning:{effort}` | `reasoning_effort` |
| `text:{format}` | `response_format` |
| `max_output_tokens` | `max_tokens` |
| `store`, `include`, `truncation`, `previous_response_id`, `prompt_cache_retention`, `stream_options` | dropped |

Already-nested tools and clean Chat Completions bodies pass through untouched, so
the shim works whether or not Cursor is in its confused mode, and translating
twice changes nothing.

**One deliberate lossy step:** `type:"custom"` tools carry a free-form `format`
(often a grammar) with no Chat Completions equivalent. They are promoted to a
function taking a single free-form `input` string. That keeps the tool callable
instead of rejected — which is what unblocks file edits — but if that payload
does not survive, the fix is a small amount of per-tool mapping in
`convertTools`. The capture from step 1 tells you whether it is needed.

## Tests

```sh
npm test
```

63 checks, no network and no API key required:

- `scripts/translate-check.mjs` — 32 assertions over translation, idempotence,
  and edge cases (string input, images, `developer` role, reasoning-only items,
  unsupported tools, null content)
- `scripts/smoke.mjs` — 31 assertions against a live server: boots on an
  ephemeral port, posts each payload shape Cursor is known to send, and checks
  classification, SSE output, error paths, and capture redaction

## Layout

```
src/index.ts      CLI, argument parsing, --check
src/config.ts     env loading and precedence, redaction
src/shape.ts      dialect detection
src/translate.ts  Responses → Chat Completions
src/upstream.ts   forwarding to Gateway
src/capture.ts    capture writing
src/reply.ts      canned replies for capture mode
src/server.ts     HTTP routing
```

## Security notes

- The shim forwards your Gateway key, so it binds loopback-only by default.
  Binding `SHIM_HOST` elsewhere exposes the key; `--check` warns if you do.
- Credentials are redacted before anything touches disk.
- `.env` and `captures/` are gitignored.
- The `.env` parser is not a shell — no interpolation, no command substitution —
  so a malformed file cannot run code.

## Relationship to `ollama-acp`

The streaming and tool-call-reassembly logic here mirrors the Merge Gateway
provider in the sibling `ollama-acp` project (an ACP coding agent for Xcode),
which already talks to the same Gateway surface. That project is a stdio agent;
this one is a server, which is why it is a separate repository rather than a new
entry point there.

## Limitations

- Capture mode answers with a canned message. It verifies the protocol and lets
  Cursor proceed, but it is not a model.
- The shim serves Chat Completions only. If a future Cursor build posts
  Responses-shaped bodies to `/v1/responses` and parses Responses SSE, the shim
  needs a Responses-shaped reply path.
- Non-streaming capture replies are also canned.

## License

MIT — see [LICENSE](LICENSE).
