/**
 * Traffic capture.
 *
 * The first job of this project is to find out what Cursor actually puts on the
 * wire when Agent mode runs against a custom base URL. Captures are the durable
 * record of that, so they are written before any interpretation happens and are
 * never rewritten.
 *
 * Two artefacts per run:
 *
 *   captures/index.jsonl    one compact line per request, for quick scanning
 *   captures/<stamp>-<n>.json  the full request, for reading closely
 *
 * Credentials are redacted on the way in, so a capture is safe to share.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactHeaders } from "./config.js";
import { debug, warn } from "./log.js";
import { describeShape, type BodyShape } from "./shape.js";

/**
 * Secrets to scrub from capture bodies, set by the server at startup.
 *
 * WHY BODIES NEED REDACTION TOO. `redactHeaders` covers the wire headers, but
 * the body is a full agent transcript, and transcripts absorb whatever was ever
 * printed into the conversation: `.env` dumps, echoed keys, connection info.
 * Capturing the body verbatim therefore puts every secret that ever entered
 * the session on disk in plaintext — found in live captures on 2026-09-17
 * (both the Gateway key and the client key, inside `messages[].content`).
 * The server registers its configured secrets here at startup; anything
 * matching is replaced before the JSON is written.
 */
const bodySecrets: { needle: string; label: string }[] = [];

/** Register a secret string to scrub from capture bodies. */
export function registerBodySecret(value: string | undefined, label: string): void {
  if (typeof value === "string" && value.length >= 8) bodySecrets.push({ needle: value, label });
}

/** Replace every registered secret in a string. */
function scrubText(text: string): string {
  let out = text;
  for (const { needle, label } of bodySecrets) {
    if (out.includes(needle)) out = out.split(needle).join(`[REDACTED:${label}]`);
  }
  return out;
}

/** Deeply scrub a parsed JSON body so no registered secret survives on disk. */
export function redactBody(body: unknown): unknown {
  if (bodySecrets.length === 0 || body === null || typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map(redactBody);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = scrubText(value);
    else if (value !== null && typeof value === "object") out[key] = redactBody(value);
    else out[key] = value;
  }
  return out;
}

export interface CaptureRecord {
  /** Monotonic per-process request number, matching the index.jsonl line. */
  seq: number;
  receivedAt: string;
  method: string;
  url: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  shape: BodyShape;
  rawBytes: number;
  /** Parsed body, or undefined when it was not valid JSON. */
  body?: unknown;
  /** Set when the body could not be parsed, so the capture explains itself. */
  parseError?: string;
  /** Truncated preview for bodies too large to keep whole. */
  bodyTruncated?: boolean;
}

export interface CaptureSummary {
  file: string;
  indexFile: string;
}

export class Capture {
  private seq = 0;
  private readonly dir: string;
  private readonly indexFile: string;
  private ready = false;

  constructor(dir: string) {
    this.dir = dir;
    this.indexFile = join(dir, "index.jsonl");
  }

  private ensureDir(): boolean {
    if (this.ready) return true;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.ready = true;
      return true;
    } catch (error) {
      warn(`could not create capture dir ${this.dir}: ${(error as Error).message}`);
      return false;
    }
  }

  /** Reserve the next sequence number. Single-threaded, so this is safe. */
  next(): number {
    this.seq += 1;
    return this.seq;
  }

  /** File-friendly ISO stamp; colons are illegal on some filesystems. */
  private static stamp(date: Date): string {
    return date.toISOString().replace(/[:.]/g, "-");
  }

  write(record: Omit<CaptureRecord, "headers"> & {
    headers: Record<string, string | string[] | undefined>;
  }): CaptureSummary | undefined {
    if (!this.ensureDir()) return undefined;

    const safe: CaptureRecord = {
      ...record,
      headers: redactHeaders(record.headers),
      body: record.body === undefined ? undefined : redactBody(record.body),
    };
    const file = join(
      this.dir,
      `${Capture.stamp(new Date(record.receivedAt))}-${String(record.seq).padStart(3, "0")}.json`,
    );

    try {
      writeFileSync(file, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
      // Compact index line: enough to see the shape of a whole session at once.
      const line = JSON.stringify({
        seq: safe.seq,
        at: safe.receivedAt,
        method: safe.method,
        path: safe.path,
        model: safe.shape.model,
        kind: safe.shape.kind,
        tools: safe.shape.toolFormat,
        toolCount: safe.shape.toolCount,
        customTools: safe.shape.customTools,
        stream: safe.shape.stream,
        responsesOnly: safe.shape.responsesOnlyFields,
        bytes: safe.rawBytes,
        file: file.slice(this.dir.length + 1),
      });
      appendFileSync(this.indexFile, `${line}\n`, "utf8");
    } catch (error) {
      warn(`could not write capture: ${(error as Error).message}`);
      return undefined;
    }

    debug(`capture ${safe.seq} → ${file}`);
    return { file, indexFile: this.indexFile };
  }

  /** Console line describing a request, independent of the file write. */
  static describe(record: Pick<CaptureRecord, "seq" | "method" | "path" | "shape" | "rawBytes">): string {
    const kb = (record.rawBytes / 1024).toFixed(1);
    return `#${record.seq} ${record.method} ${record.path} · ${describeShape(record.shape)} · ${kb}KB`;
  }
}
