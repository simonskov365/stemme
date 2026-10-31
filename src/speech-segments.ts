import { speechText, sentences } from "./context.js";

/** Buffers raw streamed Markdown. Only stable sentences/words outside code are spoken. */
export class SpeechSegments {
  private buffer = "";
  private pending = "";
  private first = true;
  push(delta: string, final = false): string[] {
    this.buffer += delta;
    const ready: string[] = [];
    let fence = "",
      inline = false,
      brackets = 0,
      parentheses = 0,
      start = 0;
    const flush = (raw: string, force = false) => {
      const text = speechText(raw);
      if (text) this.pending += (this.pending ? " " : "") + text;
      if (!this.pending || (!force && !this.first && this.pending.length < 180))
        return;
      const chunks = sentences(this.pending, this.first ? 240 : 450);
      ready.push(...chunks);
      this.pending = "";
      this.first = false;
    };
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (
        this.buffer.startsWith("```", i) ||
        this.buffer.startsWith("~~~", i)
      ) {
        const marker = this.buffer.slice(i, i + 3);
        if (!fence) fence = marker;
        else if (fence === marker) fence = "";
        i += 2;
        continue;
      }
      if (fence) continue;
      if (c === "`") {
        inline = !inline;
        continue;
      }
      if (inline) continue;
      if (c === "[") brackets++;
      if (c === "]") brackets = Math.max(0, brackets - 1);
      if (c === "(") parentheses++;
      if (c === ")") parentheses = Math.max(0, parentheses - 1);
      if (brackets || parentheses) continue;
      const punctuation =
        /[.!?。！？]/u.test(c) && /\s/.test(this.buffer[i + 1] ?? "");
      const newline = c === "\n";
      const longWordBoundary =
        /\s/.test(c) && i - start >= (this.first ? 240 : 450);
      if (!punctuation && !newline && !longWordBoundary) continue;
      const token = this.buffer.slice(start, i + 1).match(/\S+$/)?.[0] ?? "";
      if (
        punctuation &&
        (/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)\.$/i.test(token) ||
          /^https?:\/\//.test(token))
      )
        continue;
      flush(this.buffer.slice(start, i + 1));
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (final) {
      flush(this.buffer, true);
      this.buffer = "";
    }
    return ready;
  }
}
