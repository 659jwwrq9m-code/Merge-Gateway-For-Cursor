/**
 * The shim's HTTP server.
 *
 * Cursor is pointed here via `Override OpenAI Base URL`, so every route is
 * OpenAI-shaped. Each request is:
 *
 *   1. read, with a size cap
 *   2. classified and captured to disk (credentials redacted)
 *   3. normalised from Responses to strict Chat Completions
 *   4. either answered with a canned reply (capture mode) or forwarded to
 *      Gateway (passthrough mode)
 *
 * Capture mode is the default. It answers successfully so Cursor keeps going and
 * reveals the rest of the protocol, but it never contacts Gateway, so surveying
 * traffic cannot spend money.
 *
 * Two dialects are served, because Cursor's behaviour has changed across builds
 * and it is not worth betting on which one you have:
 *
 *   /v1/chat/completions  Chat Completions in, Chat Completions out  ← today's Cursor
 *   /v1/responses         Responses in, Responses out
 *
 * The dialect is chosen by path, and the reply shape always matches the path, so
 * a client parsing either format gets something it can read.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Capture } from "./capture.js";
import { errorBody, jsonCompletion, jsonResponse, sseCompletion, sseResponse } from "./reply.js";
import type { ShimConfig } from "./config.js";
import { classifyBody, describeShape, type BodyShape } from "./shape.js";
import { toChatCompletions } from "./translate.js";
import { readCatalog, toOpenAIModelList, type CatalogModel } from "./catalog.js";
import { forwardChatCompletion, forwardModels, forwardNativeModels, forwardResponses } from "./upstream.js";
import { reshapeChunk, reshapeChunks, reshapeCompletion } from "./reshape.js";
import { debug, info, request as logRequest, warn } from "./log.js";

/** Which wire dialect the request path implies, and therefore the reply shape. */
type Dialect = "chat_completions" | "responses";

interface ReadResult {
  raw: Buffer;
  text: string;
  truncated: boolean;
}

/**
 * Process-lifetime memo for the model catalogue.
 *
 * Held by closure rather than a module global so tests can spin up independent
 * servers, and so a restart is always a clean read.
 */
interface CatalogCache {
  catalog?: CatalogModel[];
}

/**
 * Read a request body, refusing to buffer more than the configured cap.
 *
 * Returns as soon as the cap is exceeded, then destroys the stream — a runaway
 * body should not be able to exhaust memory just because Cursor is pointed here.
 */
async function readBody(req: IncomingMessage, cap: number): Promise<ReadResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > cap) {
      truncated = true;
      warn(`request body exceeded ${(cap / 1024 / 1024).toFixed(0)}MB cap; truncating`);
      req.destroy();
      break;
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks);
  return { raw, text: raw.toString("utf8"), truncated };
}

function parseJson(text: string): { body?: unknown; error?: string } {
  if (!text.trim()) return { error: "empty body" };
  try {
    return { body: JSON.parse(text) as unknown };
  } catch (parseError) {
    return { error: (parseError as Error).message };
  }
}

/** Cursor sometimes omits the model; fall back so replies stay well-formed. */
function pickModel(shape: BodyShape, config: ShimConfig): string {
  return shape.model ?? config.defaultModel ?? "shim/unknown";
}

function sendJson(res: ServerResponse, status: number, payload: string): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Pipe an upstream response through, preserving status and content type.
 *
 * When `reshape` is given, a successful body is rewritten on the way out into
 * the dialect Cursor's Agent loop parses — see `reshape.ts` for why. Errors are
 * never reshaped: a 4xx body is Gateway's own error wording and the client
 * should see it verbatim.
 */
async function relayResponse(
  res: ServerResponse,
  upstream: Response,
  reshape?: { model?: string },
): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  const rewritable = reshape !== undefined && upstream.status < 400;

  if (rewritable && /text\/event-stream/i.test(contentType)) {
    if (!upstream.body) {
      res.writeHead(upstream.status, { "Content-Type": contentType });
      res.end();
      return;
    }
    await relayStreamReshaped(res, upstream, contentType, reshape.model);
    return;
  }

  if (rewritable && /application\/json/i.test(contentType)) {
    const text = await upstream.text();
    let payload = text;
    try {
      payload = JSON.stringify(reshapeCompletion(JSON.parse(text), reshape.model));
    } catch {
      // Not JSON after all — pass the original bytes through untouched.
    }
    sendJson(res, upstream.status, payload);
    return;
  }

  res.writeHead(upstream.status, { "Content-Type": contentType });

  if (!upstream.body) {
    res.end();
    return;
  }

  // Cast keeps this working across Node's WebStream/NodeStream typings without
  // pulling in a helper; the runtime accepts a web ReadableStream directly.
  const { Readable } = await import("node:stream");
  const readable = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  readable.pipe(res);
}

/**
 * Rewrite a chunked SSE stream, frame by frame.
 *
 * Frames are only ever rewritten on a complete line boundary, so a chunk split
 * mid-JSON is held in the buffer rather than parsed half-formed. Dropped frames
 * take their trailing blank line with them, which is what actually collapses
 * Gateway's ~160-frame turn into something near Ollama's ~10; leaving the blank
 * lines behind would emit a stream of empty events for no benefit.
 *
 * `lastDropped` is the only piece of cross-frame state, and it exists purely to
 * pair a dropped `data:` line with the separator that follows it.
 */
async function relayStreamReshaped(
  res: ServerResponse,
  upstream: Response,
  contentType: string,
  model: string | undefined,
): Promise<void> {
  res.writeHead(upstream.status, { "Content-Type": contentType, "Cache-Control": "no-cache" });

  const { Readable } = await import("node:stream");
  const readable = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);

  let buffer = "";
  let lastDropped = false;

  const emit = (line: string): void => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;

    if (trimmed === "") {
      // Swallow the separator belonging to a frame we just dropped.
      if (lastDropped) return;
      res.write("\n");
      return;
    }

    if (!trimmed.startsWith("data:")) {
      res.write(`${trimmed}\n`);
      return;
    }

    const payload = trimmed.slice(5).trim();
    if (payload === "" || payload === "[DONE]") {
      res.write(`${trimmed}\n`);
      lastDropped = false;
      return;
    }

    let next: unknown[];
    try {
      next = reshapeChunks(JSON.parse(payload), model);
    } catch {
      // Unparseable frame: forward it rather than silently eating content.
      res.write(`${trimmed}\n`);
      lastDropped = false;
      return;
    }

    if (next.length === 0) {
      lastDropped = true;
      return;
    }

    // A frame carrying several tool calls becomes one frame per call, so a
    // streaming client that accumulates per frame sees every call. See
    // `reshapeChunks`.
    for (const frame of next) {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
    lastDropped = false;
  };

  for await (const chunk of readable) {
    buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      emit(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }

  if (buffer) emit(buffer);
  res.end();
}

/** Addresses that mean "something on this machine". */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Headers that mean the request arrived through something in front of the shim.
 *
 * `cf-ray` and `cf-connecting-ip` are Cloudflare's; `x-forwarded-for` is the
 * generic one.
 */
const PROXY_HEADERS = ["cf-ray", "cf-connecting-ip", "x-forwarded-for", "x-real-ip"];

/**
 * Did this request come from this machine, rather than through a tunnel?
 *
 * Loopback **alone cannot answer that**: a Cloudflare tunnel dials the shim over
 * loopback, so a request from the public internet arrives looking local by
 * address. It does not look local by *header* — cloudflared always adds its own
 * — and those cannot be forged by anyone outside, because the origin has no
 * inbound port to reach. The only way in is the tunnel, which adds them.
 *
 * This is what lets Xcode connect locally with no key while Cursor comes through
 * the tunnel with one, on the same port, without weakening either: the key still
 * guards every request that is not from this machine.
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? "";
  if (!LOOPBACK_ADDRESSES.has(remote)) return false;
  return !PROXY_HEADERS.some((name) => req.headers[name] !== undefined);
}

/**
 * Does this request carry the configured client key?
 *
 * Compared in constant time: a byte-by-byte early return leaks the secret's
 * length and prefix to anyone who can time a response. A mismatch on length is
 * still compared so the timing stays flat.
 *
 * Both `Authorization: Bearer <key>` and a bare `x-api-key` are accepted,
 * because clients differ on which they send and Cursor only offers one field.
 */
function presentsClientKey(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  const fromAuth = typeof header === "string" ? header.replace(/^Bearer\s+/i, "") : "";
  const fromApiKey = req.headers["x-api-key"];
  const presented = fromAuth || (typeof fromApiKey === "string" ? fromApiKey : "");

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so a wrong length is not measurably faster.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Turn off reasoning for requests whose conversation cannot carry it back.
 *
 * Some providers reject a follow-up turn of a tool conversation unless the
 * previous turn's `reasoning_content` is returned verbatim — DeepSeek's thinking
 * mode does this through Gateway, with `invalid_request_error`. Agent clients
 * generally do not preserve that field, so the turn fails and the client retries
 * the same conversation forever.
 *
 * The check is deliberately narrow: only when the request actually carries tool
 * results, and only when the client has not asked for reasoning itself. A plain
 * chat turn keeps whatever reasoning the caller wanted, so this cannot silently
 * degrade a request that would have worked.
 *
 * `reasoning_effort: "none"` is what satisfies the provider; sending a fabricated
 * `reasoning_content` does not, which was measured against Gateway directly.
 */
export function disableUnpreservableReasoning(body: unknown, config: ShimConfig): string | undefined {
  if (!config.forceToolReasoningOff) return undefined;
  if (typeof body !== "object" || body === null) return undefined;

  const request = body as Record<string, unknown>;
  // A caller who set reasoning_effort chose it deliberately; leave it alone.
  // Already-"none" needs no rewrite either, so this is a genuine no-op then.
  if (request.reasoning_effort !== undefined) return undefined;

  const messages = request.messages;
  if (!Array.isArray(messages)) return undefined;

  // Only the turn that returns tool results is at risk: that is the shape the
  // provider refuses without the prior reasoning.
  const returnsToolResults = messages.some(
    (message) =>
      typeof message === "object" && message !== null && (message as { role?: unknown }).role === "tool",
  );
  if (!returnsToolResults) return undefined;

  // Scoped to the providers that actually demand the echo, because the rewrite
  // is not free: it suppresses reasoning on a turn where the provider would
  // happily have produced it, and in an agent loop nearly every turn returns
  // tool results. Applying it everywhere made reasoning effectively vanish for
  // models that never needed it — measured on `zai/glm-5.3-flash`, which
  // answered a tool turn fine either way and simply had its reasoning stripped.
  const needsEcho = requiresReasoningEcho(request.model);
  if (!needsEcho) return undefined;

  request.reasoning_effort = "none";
  return `disabled reasoning for a tool-result turn, which ${needsEcho} otherwise rejects`;
}

/**
 * Providers that reject a tool-result follow-up unless the previous turn's
 * reasoning is echoed back.
 *
 * Kept to an explicit allow-list of known offenders rather than applied
 * globally: an unrecognised model should get its reasoning, since the failure
 * mode for a provider that does not need the echo is only a needlessly
 * suppressed thought, whereas disabling reasoning for one that does need it is
 * a 400 and a looping agent. Getting it wrong in that direction is worse.
 */
export function requiresReasoningEcho(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  const id = model.toLowerCase();
  if (id.includes("deepseek")) return "DeepSeek's thinking mode";
  return undefined;
}

/** Explain a shape mismatch, which is far more common than a genuine bad request. */function dialectHint(shape: BodyShape, dialect: Dialect): string | undefined {
  const path = dialect === "responses" ? "/v1/responses" : "/v1/chat/completions";
  const needed = dialect === "responses" ? "input" : "messages";
  const needsOther = dialect === "responses" ? shape.hasMessages : shape.hasInput;

  if (needsOther && !shape[dialect === "responses" ? "hasInput" : "hasMessages"]) {
    const other = dialect === "responses" ? "/v1/chat/completions" : "/v1/responses";
    return `This request was sent to ${path} with a ${dialect === "responses" ? "Chat Completions" : "Responses"}-shaped body. Send it to ${other} instead, or post a body containing \`${needed}\`.`;
  }
  return undefined;
}

export function createShimServer(config: ShimConfig): Server {
  return createServer(createRequestHandler(config));
}

/**
 * Build the advertised catalogue from Gateway's native models endpoint.
 *
 * Returns undefined when the catalogue could not be read, so the caller can fall
 * back rather than presenting an empty picker.
 *
 * One upstream call, on the `GET /models` path only — a picker refresh or a
 * provider "Verify" click. Completions never come through here, so the cost sits
 * outside the agent loop entirely.
 */
async function buildCatalog(config: ShimConfig): Promise<CatalogModel[] | undefined> {
  const native = await forwardNativeModels(config);
  if (!native.ok) {
    warn(`Gateway returned ${native.status} for the native catalogue`);
    return undefined;
  }

  const catalog = readCatalog(await native.json());
  return catalog.length > 0 ? catalog : undefined;
}

/**
 * Serve the model list a picker should see.
 *
 * The native catalogue is the source of truth (see `catalog.ts` for why the
 * OpenAI surface is not), so this does not proxy it through. The result is
 * cached for the process lifetime: the catalogue holds a few hundred entries and
 * changes on the order of releases, not seconds, while a picker refresh or a
 * provider "Verify" click hits this path repeatedly.
 */
async function serveCatalog(res: ServerResponse, cache: CatalogCache, config: ShimConfig): Promise<void> {
  const catalog = cache.catalog ?? (await buildCatalog(config).catch(() => undefined));
  if (catalog) {
    cache.catalog = catalog;
    sendJson(res, 200, JSON.stringify({ object: "list", data: toOpenAIModelList(catalog) }));
    return;
  }

  // A minimal but correctly-shaped list, so a picker still populates.
  warn("could not read the Gateway catalogue; serving a stub instead");
  const models = [config.defaultModel ?? "anthropic/claude-opus-5"].map((id) => ({
    id,
    object: "model",
    created: 0,
    owned_by: "merge-gateway",
  }));
  sendJson(res, 200, JSON.stringify({ object: "list", data: models }));
}

/**
 * Build the request handler.
 *
 * Separate from the server so the same handler can be attached to more than one
 * listener — see `startServer`, which binds both loopback stacks.
 */
function createRequestHandler(config: ShimConfig): (req: IncomingMessage, res: ServerResponse) => void {
  const capture = new Capture(config.captureDir);
  const catalogCache: CatalogCache = {};

  return (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      warn(`unhandled error: ${message}`);
      if (!res.headersSent) sendJson(res, 500, errorBody(message, "server_error"));
      else res.end();
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // `/health` stays open: it reveals only whether the shim is up, and a
    // tunnel or uptime check needs to reach it without holding the secret.
    if (path === "/health") {
      sendJson(
        res,
        200,
        JSON.stringify({ status: "ok", mode: config.passthrough ? "passthrough" : "capture" }),
      );
      return;
    }

    // A prefix-tolerant view of the path, so the same route can be reached at
    // the names different clients actually construct.
    //
    // Xcode's provider field holds a host with no `/v1` in it and Xcode appends
    // one itself, so a base URL of `http://localhost:8899/v1` produces requests
    // for `/v1/v1/models`. Cursor does the opposite and takes the base URL
    // verbatim. Matching the suffix rather than the whole path serves both at
    // once instead of forcing one client to change to suit the other, which
    // would mean the two could never be pointed at the same shim.
    const route = path.replace(/\/{2,}/g, "/").replace(/\/+$/, "").replace(/^(?:\/v1)+(?=\/|$)/, "");
    const isModels = route === "/models";

    // The model list is deliberately readable without the key.
    //
    // Both editors fetch it to populate their picker, and neither sends
    // credentials for that call as reliably as it does for a completion — Xcode
    // in particular offers nowhere obvious to put one. Gating it therefore
    // breaks the picker while protecting nothing: the endpoint proxies Gateway's
    // catalogue, which is a free, authenticated call the shim makes with its own
    // key, so a caller learns the model names and nothing else. It cannot spend
    // anything. The key still gates every path that can reach a completion.
    if (isModels) {
      await handleModels(res);
      return;
    }

    // Gate everything that can reach Gateway. A tunnel makes this URL public, and
    // the shim holds the real Gateway key, so without a check anyone who learns
    // the URL can spend those credits — the inbound Authorization header is not
    // forwarded upstream and is otherwise ignored.
    //
    // Requests from this machine are exempt, which is what lets Xcode talk to the
    // shim at all: it has nowhere obvious to put a token for a local provider, and
    // requiring one would make Xcode and Cursor mutually exclusive on a single
    // port. The exemption does not widen exposure, because a tunnelled request is
    // never treated as local — see `isLocalRequest`.
    if (config.clientKey && !isLocalRequest(req) && !presentsClientKey(req, config.clientKey)) {
      // Header *names* only, never values: this is the diagnostic that tells us
      // which field a given client actually uses, and it must stay safe to paste
      // into a log or an issue.
      const presented = Object.keys(req.headers)
        .filter((name) => /auth|key|token|bearer|api/i.test(name))
        .join(", ");
      const via = PROXY_HEADERS.filter((name) => req.headers[name] !== undefined).join(", ");
      warn(
        `rejected ${method} ${path}: not local and no valid SHIM_CLIENT_KEY` +
          ` [remote=${req.socket.remoteAddress ?? "?"}` +
          (via ? `, proxy headers=${via}` : ", no proxy headers") +
          `, user-agent=${String(req.headers["user-agent"] ?? "?")}]` +
          (presented ? ` (credential-ish headers present: ${presented})` : " (no credential headers at all)"),
      );
      sendJson(
        res,
        401,
        errorBody(
          "merge-gateway-shim requires the configured SHIM_CLIENT_KEY as an `Authorization: Bearer …` token.",
          "invalid_api_key",
        ),
      );
      return;
    }

    const dialect: Dialect | undefined = route.endsWith("/chat/completions")
      ? "chat_completions"
      : route.endsWith("/responses")
        ? "responses"
        : undefined;

    if (method !== "POST" || !dialect) {
      // Anything unexpected still gets logged; silence would be worse than noise.
      warn(`unhandled ${method} ${path}`);
      sendJson(res, 404, errorBody(`merge-gateway-shim does not serve ${method} ${path}`, "not_found"));
      return;
    }

    await handleCompletion(req, res, dialect, method, path, url);
  }

  async function handleModels(res: ServerResponse): Promise<void> {
    // Unfiltered mode proxies Gateway's OpenAI surface directly, which is the
    // list this shim would otherwise have to reproduce.
    if (!config.filterModels && config.apiKey) {
      try {
        const upstream = await forwardModels(config);
        if (upstream.ok) {
          await relayResponse(res, upstream);
          return;
        }
        warn(`Gateway returned ${upstream.status} for the model list; falling back to the catalogue`);
      } catch (error) {
        warn(`could not fetch the model list: ${(error as Error).message}`);
      }
    }

    await serveCatalog(res, catalogCache, config);
  }

  async function handleCompletion(
    req: IncomingMessage,
    res: ServerResponse,
    dialect: Dialect,
    method: string,
    path: string,
    url: URL,
  ): Promise<void> {
    const seq = capture.next();
    const receivedAt = new Date().toISOString();

    const { raw, text, truncated } = await readBody(req, config.maxBodyBytes);
    const { body, error: parseError } = parseJson(text);
    const shape = classifyBody(body);

    const record = {
      seq,
      receivedAt,
      method,
      url: url.toString(),
      path,
      headers: req.headers as Record<string, string | string[] | undefined>,
      shape,
      rawBytes: raw.length,
      body,
      ...(parseError ? { parseError } : {}),
      ...(truncated ? { bodyTruncated: true } : {}),
    };

    if (config.capture) {
      const written = capture.write(record);
      if (written && !config.quiet) logRequest(`${Capture.describe(record)} → ${written.file}`);
    } else if (!config.quiet) {
      logRequest(Capture.describe(record));
    }

    if (!config.quiet) {
      // Shape detail is the whole point of a capture run, so print it inline.
      logRequest(`   ${describeShape(shape)}`);
      if (shape.topLevelKeys.length > 0) {
        logRequest(`   keys: ${shape.topLevelKeys.join(", ")}`);
      }
    }

    if (parseError) {
      warn(`body was not valid JSON (${parseError}); answering with an error`);
      sendJson(res, 400, errorBody(`merge-gateway-shim could not parse the request body: ${parseError}`));
      return;
    }

    // A Responses request is already in the dialect Gateway's /responses wants,
    // so it is forwarded as-is. A Chat request is normalised, because Cursor may
    // have sent a Responses-shaped body to the Chat path — that mismatch is the
    // exact failure this project exists to work around, so it must be translated
    // rather than rejected.
    let outbound: unknown = body;
    let notes: string[] = [];
    if (dialect !== "responses") {
      ({ body: outbound, notes } = toChatCompletions(body));
      if (notes.length > 0) debug(`translate: ${notes.join("; ")}`);
    }

    // Reasoning models on some providers (DeepSeek's thinking mode, via Gateway)
    // reject a multi-turn tool conversation unless the previous turn's reasoning
    // is echoed back verbatim as `reasoning_content`. Cursor cannot preserve it,
    // so the second request of any tool conversation would 400 — which surfaces
    // in the client as an endless "reconnecting" loop, not as an error.
    //
    // Disabling reasoning for these requests is the workable fix: the model
    // answers with tool calls as usual, and the agent loop completes.
    const reasoningNote = disableUnpreservableReasoning(outbound, config);
    if (reasoningNote) {
      notes = [...notes, reasoningNote];
      debug(`reasoning: ${reasoningNote}`);
    }

    // Only now, with translation attempted, is a shape mismatch worth naming: it
    // means the body is neither dialect for this path and a generic 400 would
    // hide why.
    const hint = dialectHint(shape, dialect);
    if (hint && notes.length === 0) {
      warn(hint);
      sendJson(res, 400, errorBody(hint));
      return;
    }

    if (config.passthrough) {
      await handlePassthrough(res, outbound, seq, dialect, pickModel(shape, config));
      return;
    }

    await handleCaptureReply(res, shape, raw.length, dialect);
  }

  async function handlePassthrough(
    res: ServerResponse,
    outbound: unknown,
    seq: number,
    dialect: Dialect,
    model?: string,
  ): Promise<void> {
    if (!config.apiKey) {
      warn("passthrough requested but MERGE_GATEWAY_API_KEY is not set");
      sendJson(
        res,
        500,
        errorBody("merge-gateway-shim has no MERGE_GATEWAY_API_KEY configured. Set it in .env"),
      );
      return;
    }

    try {
      const upstream =
        dialect === "responses"
          ? await forwardResponses({ config, body: outbound })
          : await forwardChatCompletion({ config, body: outbound });

      if (upstream.status >= 400) {
        const detail = await upstream.text();
        warn(`Gateway returned ${upstream.status} for #${seq}: ${detail.slice(0, 400)}`);
        sendJson(res, upstream.status, detail || errorBody("upstream error"));
        return;
      }
      if (!config.quiet) logRequest(`   → forwarded to Gateway (${upstream.status})`);
      await relayResponse(res, upstream, { model });
    } catch (error) {
      const message = (error as Error).message;
      warn(`could not reach Gateway: ${message}`);
      sendJson(res, 502, errorBody(`merge-gateway-shim could not reach Gateway: ${message}`, "upstream_error"));
    }
  }

  async function handleCaptureReply(
    res: ServerResponse,
    shape: BodyShape,
    promptBytes: number,
    dialect: Dialect,
  ): Promise<void> {
    const model = pickModel(shape, config);

    const message = [
      "merge-gateway-shim capture mode",
      `path: /v1/${dialect === "responses" ? "responses" : "chat/completions"}`,
      `shape: ${shape.kind}, tools: ${shape.toolFormat} (${shape.toolCount})`,
      shape.customTools.length > 0 ? `custom tools: ${shape.customTools.join(", ")}` : "",
      "Set SHIM_PASSTHROUGH=1 to forward to Merge Gateway.",
    ]
      .filter(Boolean)
      .join("\n");

    if (!shape.stream) {
      const payload =
        dialect === "responses"
          ? jsonResponse({ model, stream: false, content: message }, promptBytes)
          : jsonCompletion({ model, stream: false, content: message }, promptBytes);
      sendJson(res, 200, payload);
      return;
    }

    const payload =
      dialect === "responses"
        ? sseResponse({ model, stream: true, content: message }, promptBytes)
        : sseCompletion({ model, stream: true, content: message }, promptBytes);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.end(payload);
  }
}

/**
 * Bind loopback on both address families.
 *
 * `localhost` resolves to `::1` before `127.0.0.1` on macOS, and a client that
 * only tries the first answer gets ECONNREFUSED against a IPv4-only listener.
 * curl falls back to IPv4 so this is invisible from the shell, but URLSession —
 * which is what Xcode uses — does not necessarily. Binding both removes the
 * question entirely.
 *
 * A non-loopback host gets a single listener, since the user has explicitly
 * chosen an interface and silently adding another would widen exposure.
 */
export function startServer(config: ShimConfig): Server {
  const mode = config.passthrough ? "passthrough → Gateway" : "capture only (no upstream calls)";
  const handler = createRequestHandler(config);
  const primary = createServer(handler);

  const listeners: Server[] = [primary];

  if (config.host === "localhost") {
    // `::` accepts IPv4-mapped traffic on dual-stack systems, so this one socket
    // covers both families. If the host has IPv6 disabled, fall back to IPv4.
    const secondary = createServer(handler);
    const fallback = createServer(handler);
    let settled = false;

    secondary.on("error", () => {
      if (settled) return;
      settled = true;
      secondary.close();
      fallback.listen(config.port, "127.0.0.1", () => {
        info(`listening on http://127.0.0.1:${config.port}/v1 (IPv4 only) · ${mode}`);
      });
      fallback.on("error", (error: NodeJS.ErrnoException) => reportListenError(error, config));
    });

    secondary.listen(config.port, "::", () => {
      settled = true;
      info(`listening on http://localhost:${config.port}/v1 (IPv4 + IPv6) · ${mode}`);
    });

    listeners.push(secondary, fallback);
  } else {
    primary.listen(config.port, config.host, () => {
      info(`listening on http://${config.host}:${config.port}/v1 · ${mode}`);
    });
    primary.on("error", (error: NodeJS.ErrnoException) => reportListenError(error, config));
  }

  return primary;
}

function reportListenError(error: NodeJS.ErrnoException, config: ShimConfig): void {
  if (error.code === "EADDRINUSE") {
    warn(`port ${config.port} is already in use. Stop the other process or pass --port <n>.`);
  } else {
    warn(`could not listen on ${config.host}:${config.port} — ${error.message}`);
  }
  process.exitCode = 1;
}
