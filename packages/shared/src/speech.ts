/** Text helpers for reading assistant replies aloud (used by the voice client). */

/** Plain spoken text from an assistant reply: no markdown, tables or evidence ids. */
export function toSpeech(md: string) {
  return md
    .split("\n")
    .filter((l) => !/^\s*\|/.test(l)) // tables stay on screen
    .join("\n")
    .replace(/\[(E\d+)(?:\s*,\s*E\d+)*\]/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s*\n\s*/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Splits streamed text into sentences as soon as they're complete: a sentence
 * ends at . ! ? followed by whitespace, or at a newline. Text is never dropped
 * ("3.57" stays together because the "." isn't followed by a space).
 */
export class SentenceChunker {
  private buf = "";
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      let cut = -1;
      for (let i = 0; i < this.buf.length; i++) {
        const c = this.buf[i]!;
        if (c === "\n" || (".!?".includes(c) && i + 1 < this.buf.length && /\s/.test(this.buf[i + 1]!))) { cut = i + 1; break; }
      }
      if (cut < 0) break;
      const sentence = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut);
      if (sentence.trim().length >= 2) out.push(sentence);
    }
    return out;
  }
  flush(): string[] {
    const rest = this.buf;
    this.buf = "";
    return rest.trim() ? [rest] : [];
  }
}

