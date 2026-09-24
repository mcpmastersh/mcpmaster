// Terminal output for the `mcpmaster` CLI — the same rules as the rest of the
// mcpmaster design system, translated to a TTY:
//
//   - stdout is data, stderr is everything else. `mcpmaster call … | jq` and
//     `mcpmaster tools --json` must never see a status line.
//   - Decoration is capability-gated. MCPMASTER_PLAIN=1 or any non-TTY gets
//     zero escape bytes; NO_COLOR outranks FORCE_COLOR; ASCII glyphs when the
//     locale can't render Unicode.
//   - One accent (#8b7bff) for the thing that matters on a line; status colors
//     only for status; body text stays in the terminal's own foreground.

const RESET = "\x1b[0m";

function truthy(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false"].includes(value.trim().toLowerCase());
}

function detectColor(): boolean {
  if (truthy(process.env.MCPMASTER_PLAIN)) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "") return process.env.FORCE_COLOR !== "0";
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stderr.isTTY);
}

function detectUnicode(): boolean {
  if (truthy(process.env.MCPMASTER_PLAIN) || truthy(process.env.MCPMASTER_ASCII)) return false;
  if (process.platform === "win32") return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM);
  const locale = `${process.env.LC_ALL ?? ""}${process.env.LC_CTYPE ?? ""}${process.env.LANG ?? ""}`;
  return /utf-?8/i.test(locale) || process.env.TERM_PROGRAM !== undefined;
}

let color = detectColor();
let unicode = detectUnicode();

export function setPlain(): void {
  color = false;
  unicode = false;
}

const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
const paint = (tc: string, basic: string) => (text: string) =>
  color ? `\x1b[${truecolor ? tc : basic}m${text}${RESET}` : text;

export const accent = paint("38;2;139;123;255", "35");
export const muted = paint("38;2;150;150;166", "90");
export const success = paint("38;2;50;213;131", "32");
export const warning = paint("38;2;253;176;34", "33");
export const danger = paint("38;2;249;112;102", "31");
export const bold = (text: string) => (color ? `\x1b[1m${text}${RESET}` : text);

export type Kind = "ok" | "fail" | "warn" | "info";

export function glyph(kind: Kind): string {
  const set = unicode ? { ok: "✓", fail: "✗", warn: "!", info: "·" } : { ok: "+", fail: "x", warn: "!", info: "-" };
  const tint = { ok: success, fail: danger, warn: warning, info: muted }[kind];
  return tint(set[kind]);
}

export function arrow(): string {
  return accent(unicode ? "→" : "->");
}

const ANSI = /\x1b\[[0-9;]*m/g;
export function visibleWidth(text: string): number {
  return text.replace(ANSI, "").length;
}

export function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Human-facing line → stderr. */
export function say(line = ""): void {
  process.stderr.write(`${line}\n`);
}

/** Data → stdout. */
export function out(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

// Components — every command composes these rather than printing its own layout.

export const heading = (command: string, subject?: string) =>
  `  ${bold("mcpmaster")} ${bold(command)}${subject ? ` ${muted("·")} ${muted(subject)}` : ""}`;

export const row = (kind: Kind, label: string, detail = "", width = 0) =>
  `  ${glyph(kind)}  ${pad(label, width)}${detail ? `  ${muted(detail)}` : ""}`;

export const action = (command: string, suffix?: string) => `  ${arrow()} ${accent(command)}${suffix ? `  ${muted(suffix)}` : ""}`;

export const note = (text: string) => `    ${muted(text)}`;

export function spinner(text: string): { stop(): void } {
  if (!color || !process.stderr.isTTY) return { stop() {} };
  const frames = unicode ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["-", "\\", "|", "/"];
  let i = 0;
  let timer: NodeJS.Timeout | null = null;
  const delay = setTimeout(() => {
    timer = setInterval(() => process.stderr.write(`\r  ${accent(frames[i++ % frames.length])} ${muted(text)}`), 80);
  }, 150);
  return {
    stop() {
      clearTimeout(delay);
      if (timer) {
        clearInterval(timer);
        process.stderr.write("\r\x1b[2K");
      }
    },
  };
}

export class CliError extends Error {
  readonly actions: string[];
  readonly exitCode: number;

  constructor(message: string, actions: string[] = [], exitCode = 1) {
    super(message);
    this.actions = actions;
    this.exitCode = exitCode;
  }
}
