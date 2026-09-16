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
import { Capture } from "./capture.js";
import { errorBody, jsonCompletion, jsonResponse, sseCompletion, sseResponse } from "./reply.js";
import type { ShimConfig } from "./config.js";
import { classifyBody, describeShape, type BodyShape } from "./shape.js";
import { toChatCompletions } from "./translate.js";
import { forwardChatCompletion, forwardModels, forwardResponses } from "./upstream.js";
import { debug, info, request as logRequest, warn } from "./log.js";

/** Which wire dialect the request path implies, and therefore the reply shape. */
type Dialect = "chat_completions" | "responses";

interface ReadResult {
  raw: Buffer;
  text: string;
  truncated: boolean;
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

/** Pipe an upstream response through, preserving status and content type. */
async function relayResponse(res: ServerResponse, upstream: Response): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "application/json";
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

/** Explain a shape mismatch, which is far more common than a genuine bad request. */
function dialectHint(shape: BodyShape, dialect: Dialect): string | undefined {
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
  const capture = new Capture(config.captureDir);

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      warn(`unhandled error: ${message}`);
      if (!res.headersSent) sendJson(res, 500, errorBody(message, "server_error"));
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (path === "/health") {
      sendJson(
        res,
        200,
        JSON.stringify({ status: "ok", mode: config.passthrough ? "passthrough" : "capture" }),
      );
      return;
    }

    // Cursor's "Verify" step, and its model picker, hit the models endpoint.
    if (path === "/v1/models" || path === "/models") {
      await handleModels(res);
      return;
    }

    const dialect: Dialect | undefined = path.endsWith("/chat/completions")
      ? "chat_completions"
      : path.endsWith("/responses")
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
    if (!config.passthrough || !config.apiKey) {
      // A minimal list keeps Cursor's picker happy in capture mode.
      const models = [config.defaultModel ?? "anthropic/claude-opus-5"].map((id) => ({
        id,
        object: "model",
        owned_by: "merge-gateway",
      }));
      sendJson(res, 200, JSON.stringify({ object: "list", data: models }));
      return;
    }

    try {
      const upstream = await forwardModels(config);
      await relayResponse(res, upstream);
    } catch (error) {
      sendJson(res, 502, errorBody(`could not reach Gateway: ${(error as Error).message}`, "upstream_error"));
    }
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

    // The shape mismatch is worth naming explicitly: it is the exact failure this
    // project exists to work around, and a generic 400 would hide it.
    const hint = dialectHint(shape, dialect);
    if (hint) {
      warn(hint);
      sendJson(res, 400, errorBody(hint));
      return;
    }

    // A Responses request is already in the dialect Gateway's /responses wants,
    // so it is forwarded as-is. A Chat request is normalised, because Cursor may
    // have sent a Responses-shaped body to the Chat path.
    const isResponses = dialect === "responses";

    if (isResponses) {
      if (config.passthrough) {
        await handlePassthrough(res, body, seq, "responses");
        return;
      }
    } else {
      const { body: outbound, notes } = toChatCompletions(body);
      if (notes.length > 0) debug(`translate: ${notes.join("; ")}`);
      if (config.passthrough) {
        await handlePassthrough(res, outbound, seq, "chat_completions");
        return;
      }
    }

    await handleCaptureReply(res, shape, raw.length, dialect);
  }

  async function handlePassthrough(
    res: ServerResponse,
    outbound: unknown,
    seq: number,
    dialect: Dialect,
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
      await relayResponse(res, upstream);
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

  return server;
}

export function startServer(config: ShimConfig): Server {
  const server = createShimServer(config);
  server.listen(config.port, config.host, () => {
    const mode = config.passthrough ? "passthrough → Gateway" : "capture only (no upstream calls)";
    info(`listening on http://${config.host}:${config.port}/v1 · ${mode}`);
  });
  return server;
}
