#!/usr/bin/env node
/**
 * Inbound-auth checks.
 *
 * Once the shim is reachable through a tunnel, an unauthenticated request is a
 * free ride on the Gateway account behind it: the shim ignores the inbound
 * Authorization header, holds the real Gateway key, and bills that account. The
 * original implementation did exactly that, so these assertions are the guard.
 *
 * Run with:  node scripts/auth-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "index.js");

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const CLIENT_KEY = "sk-shim-test-key-0123456789";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
};

async function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

/** A request that would bill Gateway if it got through. */
const completion = (headers = {}) =>
  fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
  });

async function main() {
  console.log("\ninbound auth checks\n");

  const captureDir = mkdtempSync(join(tmpdir(), "shim-auth-"));
  const child = spawn(process.execPath, [entry, "--port", String(PORT), "--capture-dir", captureDir], {
    cwd: root,
    // Passthrough off so a leaked request cannot actually spend money, but the
    // auth gate is in front of it either way.
    env: { ...process.env, SHIM_PASSTHROUGH: "0", SHIM_CLIENT_KEY: CLIENT_KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    if (!(await waitForServer())) throw new Error("shim did not start");

    console.log("with SHIM_CLIENT_KEY set");
    check("no key → 401", (await completion()).status === 401);
    check("wrong key → 401", (await completion({ Authorization: "Bearer nope" })).status === 401);
    check(
      "empty bearer → 401",
      (await completion({ Authorization: "Bearer " })).status === 401,
    );
    check(
      "key of the right length but wrong value → 401",
      (await completion({ Authorization: `Bearer ${"x".repeat(CLIENT_KEY.length)}` })).status === 401,
    );

    const ok = await completion({ Authorization: `Bearer ${CLIENT_KEY}` });
    check("correct bearer → 200", ok.status === 200, `got ${ok.status}`);
    if (ok.ok) {
      // The body above sets no `stream`, so JSON is the correct reply shape.
      check("reply is JSON", (ok.headers.get("content-type") ?? "").includes("application/json"));
      await ok.text();
    }

    check(
      "x-api-key also accepted",
      (await completion({ "x-api-key": CLIENT_KEY })).status === 200,
    );

    console.log("\nmodel list is gated too");
    check("models without key → 401", (await fetch(`${BASE}/v1/models`)).status === 401);
    check(
      "models with key → 200",
      (await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${CLIENT_KEY}` } })).status === 200,
    );

    console.log("\nhealth stays open for probes");
    const health = await fetch(`${BASE}/health`);
    check("health with no key → 200", health.status === 200);
    check("health reports ok", (await health.json()).status === "ok");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
  }

  // -------------------------------------------------------------------------
  // With no key configured the shim must stay usable on loopback, which is the
  // default setup for Xcode.
  console.log("\nwith SHIM_CLIENT_KEY unset (loopback default)");
  const openChild = spawn(process.execPath, [entry, "--port", String(PORT), "--capture-dir", captureDir], {
    cwd: root,
    env: { ...process.env, SHIM_PASSTHROUGH: "0", SHIM_CLIENT_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    if (!(await waitForServer())) throw new Error("shim did not restart");
    check("no key configured → request allowed", (await completion()).status === 200);
    check("models reachable", (await fetch(`${BASE}/v1/models`)).status === 200);
  } finally {
    openChild.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`auth check error: ${error.message}`);
  process.exit(1);
});
