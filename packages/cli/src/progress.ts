import type { OutputStream } from "./environment.js";
import { terminalSafe } from "./terminal.js";

/**
 * One self-replacing status line on stderr, only when stderr is a terminal: progress never
 * reaches stdout and never pollutes a redirected log or a pipe.
 */
export class Progress {
  readonly #stream: OutputStream;
  readonly #enabled: boolean;
  #shown = false;

  constructor(stream: OutputStream, enabled: boolean) {
    this.#stream = stream;
    this.#enabled = enabled && stream.isTTY;
  }

  update(text: string): void {
    if (!this.#enabled) {
      return;
    }
    const width = Math.max(20, (this.#stream.columns ?? 80) - 1);
    const line = [...terminalSafe(text)].slice(0, width).join("");
    this.#stream.write(`\r\u001B[2K${line}`);
    this.#shown = true;
  }

  clear(): void {
    if (this.#shown) {
      this.#stream.write("\r\u001B[2K");
      this.#shown = false;
    }
  }
}
