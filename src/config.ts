/**
 * Environment loading and configuration.
 *
 * Precedence, highest first:
 *
 *   1. Command-line flags
 *   2. The real process environment (anything you exported in your shell)
 *   3. `.env` beside this project
 *   4. Built-in defaults
 *
 * `.env` sits *below* the ambient environment on purpose: a key you export for
 * one run (`MERGE_GATEWAY_API_KEY=... npm start`) should win over the file
 * without you having to edit it, which is the same ordering `ollama-acp`'s
 * launcher uses.
 *
 * Node 20.12+ ships `process.loadEnvFile`, which already refuses to overwrite a
 * variable that is set — that is precisely the precedence above, with no
 * `dotenv` dependency. Older runtimes fall back to a deliberately minimal
 * parser in this file.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { warn } from "./log.js";

const here = dirname(fileURLToPath(import.meta.url));

/** `dist/` when built, `src/` under tsx — the root is one level up either way. */
export const projectRoot = resolve(here, "..");

export const exampleEnvPath = join(projectRoot, ".env.example");

/** Default location of the file that holds the key. Overridable for tests. */
export const defaultEnvPath = join(projectRoot, ".env");

export interface LoadEnvResult {
  path: string;
  /** False when the file is absent, which is not an error on its own. */
  found: boolean;
  /** Keys the file defined and the ambient environment did not already have. */
  applied: string[];
  /** Keys the file defined that the ambient environment already set and won. */
  overridden: string[];
}

/**
 * Pull `KEY=` names out of a `.env` body.
 *
 * Only used for reporting which variables were applied — the actual assignment
 * is done by `process.loadEnvFile` (or the fallback parser), so an exotic line
 * here can at worst make the report incomplete, never corrupt the environment.
 */
function scanKeys(body: string): string[] {
  const keys: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    keys.push(key);
  }
  return keys;
}

/** Strip one layer of symmetric surrounding quotes. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0] ?? "";
    const last = value[value.length - 1] ?? "";
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  // Strip a trailing comment only when it is clearly separated.
  const hash = value.indexOf(" #");
  return hash === -1 ? value : value.slice(0, hash).trim();
}

/**
 * Minimal `KEY=value` parser for runtimes without `process.loadEnvFile`.
 *
 * Intentionally not a shell: no interpolation, no command substitution, no
 * multi-line values. A syntax error in `.env` cannot run code.
 */
function parseEnvFallback(body: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(/^export\s+/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    parsed[key] = unquote(line.slice(eq + 1).trim());
  }
  return parsed;
}

/**
 * Load `.env` into `process.env` without clobbering ambient variables.
 *
 * Returns what happened so `--check` can show it; never throws, because a
 * malformed `.env` should degrade to "no key configured", not a crash.
 */
export function loadEnv(path: string = defaultEnvPath): LoadEnvResult {
  if (!existsSync(path)) return { path, found: false, applied: [], overridden: [] };

  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (error) {
    warn(`could not read ${path}: ${(error as Error).message}`);
    return { path, found: true, applied: [], overridden: [] };
  }

  const keys = scanKeys(body);
  const alreadySet = new Set(keys.filter((key) => process.env[key] !== undefined));

  try {
    if (typeof process.loadEnvFile === "function") {
      process.loadEnvFile(path);
    } else {
      for (const [key, value] of Object.entries(parseEnvFallback(body))) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
    }
  } catch (error) {
    warn(`could not load ${path}: ${(error as Error).message}`);
    return { path, found: true, applied: [], overridden: [] };
  }

  return {
    path,
    found: true,
    applied: keys.filter((key) => !alreadySet.has(key)),
    overridden: [...alreadySet],
  };
}

export interface ShimConfig {
  /** Merge Gateway API key, or undefined when not configured. */
  apiKey?: string;
  /** Gateway's OpenAI-compatible surface, which is what Cursor expects. */
  gatewayBaseUrl: string;
  host: string;
  port: number;
  /** Fallback model id when Cursor does not send one. */
  defaultModel?: string;
  captureDir: string;
  /** Write raw request bodies to `captureDir` for the traffic survey. */
  capture: boolean;
  /** Forward to Gateway. Off by default so capture mode cannot spend money. */
  passthrough: boolean;
  /**
   * Shared secret a client must present to use the shim.
   *
   * Unset means no inbound check, which is safe only while the shim is
   * loopback-only. Exposing it through a tunnel without this makes the shim an
   * open proxy to the Gateway key: anyone who learns the URL can spend your
   * credits, and the inbound Authorization header is otherwise ignored.
   */
  clientKey?: string;
  /** Cap on buffered request bodies, in bytes. */
  maxBodyBytes: number;
  /**
   * Narrow the advertised model list to models that support tool calling.
   *
   * On by default because Cursor's Agent mode and Xcode's chat both send tools
   * immediately, so a model that cannot call them stalls the first turn.
   */
  filterModels: boolean;
  quiet: boolean;
}

export const DEFAULTS = {
  gatewayBaseUrl: "https://api-gateway.merge.dev/v1/openai",
  // `localhost` rather than `127.0.0.1` so both loopback stacks are bound.
  // macOS resolves `localhost` to `::1` first, and Xcode's "Locally Hosted"
  // provider mode builds its URL from `localhost` without offering a host
  // field — so an IPv4-only listener can be unreachable from Xcode even though
  // curl works. Still loopback-only either way.
  host: "localhost",
  port: 8787,
  captureDir: "captures",
  maxBodyBytes: 64 * 1024 * 1024,
} as const;

export interface ShimFlags {
  check?: boolean;
  help?: boolean;
  port?: string;
  host?: string;
  gatewayUrl?: string;
  model?: string;
  captureDir?: string;
  passthrough?: boolean;
  noCapture?: boolean;
  noModelFilter?: boolean;
  quiet?: boolean;
}

/** Loopback binds are safe to assume; anything else carries the key off-host. */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

const TRUEISH = new Set(["1", "true", "yes", "on"]);

function asBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return TRUEISH.has(value.trim().toLowerCase());
}

function asPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warn(`ignoring invalid port ${JSON.stringify(value)}; using ${fallback}`);
    return fallback;
  }
  return port;
}

function asPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(`ignoring invalid size ${JSON.stringify(value)}; using ${fallback}`);
    return fallback;
  }
  return Math.floor(parsed);
}

/** Trailing slashes break path joining, so normalise them away. */
function asBaseUrl(value: string | undefined, fallback: string): string {
  const raw = value?.trim();
  if (!raw) return fallback;
  if (!/^https?:\/\//i.test(raw)) {
    warn(`gateway URL ${JSON.stringify(raw)} is not http(s); using ${fallback}`);
    return fallback;
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Keys are shown only as first/last characters. Long enough to confirm you
 * pasted the key you meant, short enough not to be a usable credential.
 */
export function maskKey(key: string | undefined): string {
  if (!key) return "(not set)";
  if (key.length < 12) return "•".repeat(key.length);
  return `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)`;
}

/**
 * Catch the common paste mistakes — an untouched template value, a key with a
 * stray newline, or something that is clearly not a Gateway key.
 */
export function keyLooksPlaceholder(key: string): boolean {
  if (key.length < 20) return true;
  return /^(your|changeme|change-me|placeholder|xxx|sk-your|todo)/i.test(key.trim());
}

export function resolveConfig(
  flags: ShimFlags = {},
  env: NodeJS.ProcessEnv = process.env,
): ShimConfig {
  const port = asPort(flags.port ?? env.SHIM_PORT, DEFAULTS.port);
  const maxBodyMb = env.SHIM_MAX_BODY_MB;
  const captureDirValue = flags.captureDir ?? env.SHIM_CAPTURE_DIR ?? DEFAULTS.captureDir;

  return {
    apiKey: env.MERGE_GATEWAY_API_KEY?.trim() || undefined,
    gatewayBaseUrl: asBaseUrl(
      flags.gatewayUrl ?? env.MERGE_GATEWAY_BASE_URL,
      DEFAULTS.gatewayBaseUrl,
    ),
    host: flags.host ?? env.SHIM_HOST ?? DEFAULTS.host,
    port,
    defaultModel: flags.model ?? env.SHIM_MODEL ?? undefined,
    captureDir: isAbsolute(captureDirValue) ? captureDirValue : join(projectRoot, captureDirValue),
    capture: flags.noCapture ? false : asBool(env.SHIM_CAPTURE, true),
    passthrough: flags.passthrough ?? asBool(env.SHIM_PASSTHROUGH, false),
    maxBodyBytes: asPositiveInt(
      maxBodyMb ? String(Number(maxBodyMb) * 1024 * 1024) : env.SHIM_MAX_BODY_BYTES,
      DEFAULTS.maxBodyBytes,
    ),
    filterModels: flags.noModelFilter ? false : asBool(env.SHIM_FILTER_MODELS, true),
    clientKey: env.SHIM_CLIENT_KEY?.trim() || undefined,
    quiet: flags.quiet ?? asBool(env.SHIM_QUIET, false),
  };
}

const REDACTED = ["authorization", "x-api-key", "cookie", "set-cookie", "api-key"];

/** Never write credentials into a capture file. */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const safe: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (REDACTED.includes(key.toLowerCase())) {
      // Keep the scheme so a capture still shows *how* auth was sent.
      const rendered = Array.isArray(value) ? value.join(", ") : (value ?? "");
      const space = rendered.indexOf(" ");
      safe[key] = space > 0 ? `${rendered.slice(0, space)} ••••` : "••••";
      continue;
    }
    safe[key] = value;
  }
  return safe;
}
