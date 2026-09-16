/**
 * Logging to stderr, so stdout stays clean for anything machine-readable.
 *
 * The shim is usually started in the background next to Cursor, so every line is
 * prefixed and colourised only when stderr is a real TTY.
 */

const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;

const paint = (code: number, text: string): string =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;

const dim = (text: string): string => paint(2, text);
const cyan = (text: string): string => paint(36, text);
const yellow = (text: string): string => paint(33, text);
const red = (text: string): string => paint(31, text);

const write = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** Only printed when `SHIM_DEBUG=1`; the capture log is the durable record. */
export function debug(message: string): void {
  if (process.env.SHIM_DEBUG) write(`${dim("shim debug")} ${dim(message)}`);
}

export function info(message: string): void {
  write(`${cyan("shim")} ${message}`);
}

export function warn(message: string): void {
  write(`${yellow("shim warn")} ${message}`);
}

export function fail(message: string): void {
  write(`${red("shim error")} ${message}`);
}

/** A request line, kept visually distinct from shim diagnostics. */
export function request(message: string): void {
  write(`${dim("shim")} ${message}`);
}
