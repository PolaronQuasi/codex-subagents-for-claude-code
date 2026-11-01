// Bound matching work, not just the stored result. If exact-match scrubbing
// cannot fit these budgets, withhold the whole value instead of leaking it.
import {
  PROMPT_REDACTION_MAX_FRAGMENTS as MAX_FRAGMENTS,
  PROMPT_REDACTION_MAX_FRAGMENT_UNITS as MAX_FRAGMENT_UNITS,
  PROMPT_REDACTION_MAX_SCAN_UNITS as MAX_SCAN_UNITS,
} from "./constants.mjs";

export function boundedUtf8(text, maxBytes) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export class PromptRedactor {
  constructor(marker = "[prompt withheld]") {
    this.marker = marker;
    this.fragments = new Set();
    this.units = 0;
    this.blocked = false;
    this.resetBudget();
  }
  resetBudget() {
    this.remaining = MAX_SCAN_UNITS;
  }
  withhold() {
    this.blocked = true;
    this.fragments.clear();
  }
  addFragment(part) {
    if (!part.trim() || this.fragments.has(part)) return;
    this.units += part.length;
    if (this.fragments.size >= MAX_FRAGMENTS || this.units > MAX_FRAGMENT_UNITS) {
      this.withhold();
      return;
    }
    this.fragments.add(part);
  }
  addPrompt(prompt) {
    if (this.blocked) return;
    if (typeof prompt !== "string" || prompt.length > MAX_FRAGMENT_UNITS) {
      this.withhold();
      return;
    }
    const add = (part) => {
      this.addFragment(part);
      if (!this.blocked) this.addFragment(JSON.stringify(part).slice(1, -1));
    };
    add(prompt);
    // Stop splitting once the budget is exhausted, even for many tiny lines.
    for (let from = 0; from < prompt.length && !this.blocked;) {
      const end = prompt.indexOf("\n", from);
      add(prompt.slice(from, end < 0 ? prompt.length : end).replace(/\r$/, ""));
      from = end < 0 ? prompt.length : end + 1;
    }
  }
  redact(text, maxBytes = Infinity) {
    if (typeof text !== "string") return "";
    const work = text.length * this.fragments.size;
    if (this.blocked || work > this.remaining) return boundedUtf8(this.marker, maxBytes);
    this.remaining -= work;
    if (!this.fragments.size) return boundedUtf8(text, maxBytes);
    const hidden = new Uint8Array(text.length);
    for (const part of this.fragments) {
      let at = text.indexOf(part);
      while (at !== -1) {
        hidden.fill(1, at, at + part.length);
        at = text.indexOf(part, at + part.length);
      }
    }
    let result = "",
      from = 0,
      used = 0;
    const emit = (piece) => {
      const clipped = boundedUtf8(piece, maxBytes - used);
      result += clipped;
      used += Buffer.byteLength(clipped);
      return clipped.length === piece.length && used < maxBytes;
    };
    for (let at = 0; at < hidden.length; at++) {
      if (!hidden[at]) continue;
      if (!emit(text.slice(from, at)) || !emit(this.marker)) return result;
      while (hidden[at]) at++;
      from = at;
    }
    emit(text.slice(from));
    return result;
  }
}
