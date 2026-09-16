/**
 * Upstream forwarding to Merge Gateway.
 *
 * Gateway exposes a native OpenAI-compatible Chat Completions surface at
 * `/v1/openai/chat/completions`, and that is what this shim targets: once the
 * request is normalised to strict Chat Completions, Gateway's most-travelled
 * path handles routing, failover, budgets, and cost attribution.
 *
 * The upstream response is streamed straight back to Cursor without buffering,
 * because Chat Completions SSE already matches what Cursor's parser expects.
 */

import { debug } from "./log.js";
import { CATALOG_LIMIT } from "./catalog.js";
import type { ShimConfig } from "./config.js";

export interface ForwardOptions {
  config: ShimConfig;
  /** Already normalised to Chat Completions by `translate.ts`. */
  body: unknown;
  signal?: AbortSignal;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Send a request to Gateway and hand back the raw `Response` so the caller can
 * pipe its body onward. Errors are returned to the caller rather than thrown, so
 * the shim can render a Cursor-readable message.
 */
function gatewayHeaders(config: ShimConfig, accept: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: accept };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  // Attributes Gateway cost and applies the project's routing policy.
  const projectId = process.env.MERGE_GATEWAY_PROJECT_ID;
  if (projectId) headers["X-Merge-Project-Id"] = projectId;

  return headers;
}

async function post(
  config: ShimConfig,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const url = joinUrl(config.gatewayBaseUrl, path);
  debug(`→ POST ${url}`);

  const response = await fetch(url, {
    method: "POST",
    headers: gatewayHeaders(config, "text/event-stream, application/json"),
    body: JSON.stringify(body),
    signal: signal as RequestInit["signal"],
  });

  debug(`← ${response.status} ${response.statusText}`);
  return response;
}

export async function forwardChatCompletion({ config, body, signal }: ForwardOptions): Promise<Response> {
  return post(config, "chat/completions", body, signal);
}

/**
 * Forward a Responses-shaped request to Gateway's OpenAI Responses surface.
 *
 * The body is passed through unchanged: a client posting to `/v1/responses`
 * already speaks that dialect, so translating it would be pointless churn. Only
 * used when a client takes the Responses path, which Cursor does not today.
 */
export async function forwardResponses({ config, body, signal }: ForwardOptions): Promise<Response> {
  return post(config, "responses", body, signal);
}

/** Fetch Gateway's model catalogue so Cursor's model picker can populate. */
export async function forwardModels(config: ShimConfig): Promise<Response> {
  const url = joinUrl(config.gatewayBaseUrl, "models");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return fetch(url, { method: "GET", headers });
}

/**
 * Fetch Gateway's *native* catalogue, which is where per-model capabilities are
 * published.
 *
 * The OpenAI surface advertises ids but not what they can do, so this is the
 * only source for "supports tool calling". It is derived from the OpenAI base
 * URL rather than configured separately: `/v1/openai` is a surface mounted on
 * the same host, so stripping it lands on the native root. Keeping it derived
 * means one setting still points the shim at Gateway.
 *
 * `limit` is set well above the catalogue size so one call returns everything
 * with `has_more: false` — no cursor walk.
 */
export async function forwardNativeModels(config: ShimConfig): Promise<Response> {
  const root = config.gatewayBaseUrl.replace(/\/openai\/?$/, "");
  const url = joinUrl(root, `models?limit=${CATALOG_LIMIT}`);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return fetch(url, { method: "GET", headers });
}
