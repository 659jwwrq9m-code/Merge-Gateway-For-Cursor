#!/usr/bin/env node
/**
 * merge-gateway-shim
 *
 * Sits between Cursor's "Override OpenAI Base URL" and Merge Gateway. Two jobs,
 * in order:
 *
 *   1. Capture what Cursor actually sends in Agent mode, so the wire-format
 *      mismatch is a measurement rather than a guess.
 *   2. Normalise Responses-shaped requests to strict Chat Completions and
 *      forward them to Gateway's OpenAI surface.
 *
 * `--check` reports the resolved configuration and verifies the Gateway key
 * without needing a running server, which is the fastest way to confirm setup.
 */

import { loadEnv, exampleEnvPath, maskKey, keyLooksPlaceholder, resolveConfig, isLoopback, type ShimFlags } from "./config.js";
import { fail, info, warn } from "./log.js";
import { startServer } from "./server.js";

const USAGE = `
merge-gateway-shim — make Cursor Agent mode work through Merge Gateway

Usage
  npm start [-- options]
  node dist/index.js [options]

Options
  --check              Print resolved config, verify the Gateway key, exit
  --port <n>           Port to listen on                 (SHIM_PORT, default 8787)
  --host <addr>        Address to bind                   (SHIM_HOST, default localhost)
  --gateway-url <url>  Gateway OpenAI base URL           (MERGE_GATEWAY_BASE_URL)
  --model <id>         Fallback model id                 (SHIM_MODEL)
  --capture-dir <dir>  Where captures are written        (SHIM_CAPTURE_DIR)
  --passthrough        Forward to Gateway                (SHIM_PASSTHROUGH=1)
  --no-capture         Do not write capture files        (SHIM_CAPTURE=0)
  --no-model-filter    Advertise every model, unfiltered  (SHIM_FILTER_MODELS=0)
  --no-env             Ignore .env, use the shell environment only
  --quiet              Suppress per-request lines        (SHIM_QUIET=1)
  -h, --help           Show this help

Setup
  1.  cp .env.example .env
  2.  Put your key in it:  MERGE_GATEWAY_API_KEY=...
  3.  npm run check:env
  4.  npm start
  5.  In Cursor: Settings → Models → enable "OpenAI API Key" (paste any
      placeholder, the shim holds the real key) and "Override OpenAI Base URL"
      → http://127.0.0.1:8787/v1, then add a custom model in provider/model form.

Capture mode is the default: the shim answers without contacting Gateway, so you
can survey Cursor's traffic without spending anything.
`;

function parseArgs(argv: string[]): { flags: ShimFlags; unknown: string[] } {
  const flags: ShimFlags = {};
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string | undefined => {
      index += 1;
      return argv[index];
    };

    switch (arg) {
      case "--check":
        flags.check = true;
        break;
      case "--passthrough":
        flags.passthrough = true;
        break;
      case "--no-capture":
        flags.noCapture = true;
        break;
      case "--no-model-filter":
        flags.noModelFilter = true;
        break;
      case "--no-env":
        flags.noEnv = true;
        break;
      case "--quiet":
        flags.quiet = true;
        break;
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--port":
        flags.port = next();
        break;
      case "--host":
        flags.host = next();
        break;
      case "--gateway-url":
        flags.gatewayUrl = next();
        break;
      case "--model":
        flags.model = next();
        break;
      case "--capture-dir":
        flags.captureDir = next();
        break;
      default:
        if (arg !== undefined) unknown.push(arg);
    }
  }

  return { flags, unknown };
}

/**
 * Confirm the key works against Gateway, without burning tokens.
 *
 * `GET /models` is authenticated but free, so it is the cheapest real proof that
 * the key is valid and that the base URL is right.
 */
async function verifyKey(gatewayBaseUrl: string, apiKey: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(`${gatewayBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok) {
      const payload = (await response.json()) as { data?: unknown[] };
      const count = Array.isArray(payload.data) ? payload.data.length : 0;
      return { ok: true, detail: `key accepted, ${count} model(s) visible` };
    }

    const text = await response.text();
    return { ok: false, detail: `HTTP ${response.status} — ${text.slice(0, 300)}` };
  } catch (error) {
    return { ok: false, detail: `could not reach Gateway — ${(error as Error).message}` };
  }
}

/**
 * How `--check` describes where the `.env` values came from.
 *
 * A skipped file and a missing file are different situations and read as such:
 * "not found" tells someone to copy `.env.example`, whereas "(skipped by
 * --no-env)" tells them why the key they can see on disk is not being used.
 */
function describeEnvSource(env: { path: string; found: boolean }): string {
  if (env.path === "(skipped)") return "(skipped by --no-env)";
  return env.found ? env.path : `${env.path} (not found)`;
}

async function check(flags: ShimFlags = {}): Promise<number> {
  const env = loadEnv(flags.noEnv ? null : undefined);
  const config = resolveConfig({}, process.env);

  info("resolved configuration");
  process.stderr.write(`  .env                ${describeEnvSource(env)}\n`);
  if (env.found) {
    if (env.applied.length > 0) process.stderr.write(`  applied from .env   ${env.applied.join(", ")}\n`);
    if (env.overridden.length > 0) {
      process.stderr.write(`  already in shell    ${env.overridden.join(", ")} (shell wins)\n`);
    }
  }
  process.stderr.write(`  gateway base url    ${config.gatewayBaseUrl}\n`);
  process.stderr.write(`  api key             ${maskKey(config.apiKey)}\n`);
  process.stderr.write(`  listen              http://${config.host}:${config.port}/v1\n`);
  process.stderr.write(`  mode                ${config.passthrough ? "passthrough → Gateway" : "capture only (no upstream calls)"}\n`);
  process.stderr.write(`  capture dir         ${config.capture ? config.captureDir : "(disabled)"}\n`);
  // Loopback is what the shim binds and what Xcode (and the Cloudflare tunnel's
  // far end) dial — but it is *not* what Cursor should be pointed at: Cursor
  // reaches the shim through a tunnel hostname, and a loopback base URL does
  // not work there. Label the line accordingly so nobody copies it into Cursor.
  process.stderr.write(`  loopback url        http://${config.host}:${config.port}/v1 (Xcode / tunnel target)\n`);

  if (!config.apiKey) {
    process.stderr.write("\n");
    warn("MERGE_GATEWAY_API_KEY is not set.");
    warn(`Add it to ${env.path}, or export it in your shell.`);
    warn("Capture mode still works without a key — good for surveying traffic.");
    return 1;
  }

  if (keyLooksPlaceholder(config.apiKey)) {
    process.stderr.write("\n");
    warn("That key looks like a placeholder or is unusually short; Gateway will likely reject it.");
  }

  if (!isLoopback(config.host)) {
    process.stderr.write("\n");
    warn(`Binding ${config.host} exposes the shim beyond this machine. It forwards your Gateway key,`);
    warn("so only do that on a trusted network, or change SHIM_HOST back to 127.0.0.1.");
  }

  process.stderr.write("\n");
  info("verifying key against Gateway…");
  const result = await verifyKey(config.gatewayBaseUrl, config.apiKey);
  if (result.ok) {
    info(`✓ ${result.detail}`);
    return 0;
  }

  fail(`✗ ${result.detail}`);
  if (exampleEnvPath) process.stderr.write(`\n  Template: ${exampleEnvPath}\n`);
  return 1;
}

async function main(): Promise<void> {
  const { flags, unknown } = parseArgs(process.argv.slice(2));

  // `.env` is loaded before anything reads process.env, and never overwrites a
  // variable that is already set. `--check` loads it itself so it stays usable
  // as a standalone diagnostic. `--no-env` skips it entirely, which is how a run
  // is isolated from a developer's local configuration.
  if (!flags.check && !flags.noEnv) loadEnv();

  if (flags.help) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(0);
  }

  if (unknown.length > 0) {
    warn(`ignoring unrecognised argument(s): ${unknown.join(", ")}`);
    process.stderr.write(`${USAGE}\n`);
  }

  if (flags.check) {
    process.exit(await check(flags));
  }

  const config = resolveConfig(flags);
  if (!config.apiKey && config.passthrough) {
    fail("SHIM_PASSTHROUGH is on but MERGE_GATEWAY_API_KEY is not set. Run with --check to diagnose.");
    process.exit(1);
  }
  if (!config.apiKey) {
    warn("no MERGE_GATEWAY_API_KEY: running in capture mode. Add a key, then set SHIM_PASSTHROUGH=1.");
  }

  const server = startServer(config);

  const shutdown = (signal: string): void => {
    info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Do not hang forever on a wedged connection.
    setTimeout(() => process.exit(0), 2_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (config.passthrough) {
    info("passthrough is on: requests will be forwarded to Gateway and billed.");
  } else {
    info("capture mode: Cursor's requests are recorded and answered locally, nothing is sent to Gateway.");
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
