import { CliError } from "./errors.js";

/**
 * RPC URL policy. Provider URLs carry API keys in the path (`/v2/<key>`), the query string
 * (`?api-key=<key>`) or as credentials (`user:key@host`). Command-line flags end up in shell
 * history and in every process listing, so a URL that can hold a secret is only accepted from an
 * environment variable; a flag may only name a plain endpoint (`https://host[:port][/]`).
 */
export function checkRpcUrl(
  url: string,
  source: { readonly flag: string; readonly variable: string; readonly fromFlag: boolean },
): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(
      `${source.fromFlag ? source.flag : source.variable} is not a valid URL.`,
      "Use a full endpoint URL such as https://api.mainnet-beta.solana.com.",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CliError(
      `${source.fromFlag ? source.flag : source.variable} must be an http(s) URL (got ${parsed.protocol}).`,
      "Use the endpoint's https:// URL.",
    );
  }
  const mayHoldSecret =
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "");
  if (source.fromFlag && mayHoldSecret) {
    throw new CliError(
      `${source.flag} was given a URL with a path, query string or credentials, which may contain an API key.`,
      `Secrets are only accepted from environment variables: set ${source.variable} instead, so the key stays out of your shell history and process list.`,
    );
  }
  return parsed;
}

/**
 * Removes every configured RPC URL, and every part of one that could be a secret, from text
 * before it is written anywhere. The CLI only ever prints an endpoint's host, so this should never
 * find anything; it is the last barrier against a library error message that echoes a URL.
 */
export class Redactor {
  readonly #secrets: string[] = [];

  add(value: string | undefined): void {
    if (value === undefined || value.trim() === "") {
      return;
    }
    this.#push(value, 1);
    try {
      const url = new URL(value);
      this.#push(url.href, 1);
      this.#push(`${url.pathname}${url.search}${url.hash}`);
      this.#push(url.search);
      this.#push(url.hash);
      this.#push(url.username);
      this.#push(url.password);
      this.#push(safeDecode(url.password));
      for (const [, param] of url.searchParams) {
        this.#push(param);
      }
      for (const segment of url.pathname.split("/")) {
        this.#push(segment);
        this.#push(safeDecode(segment));
      }
    } catch {
      // Not a URL: the whole value is already listed.
    }
    // Longest first, so a whole URL is replaced before any of its parts.
    this.#secrets.sort((a, b) => b.length - a.length);
  }

  /**
   * Parts shorter than 12 characters (`/`, `v2`, `mainnet`) are too common to redact without
   * mangling normal text, and too short to be an API key (providers use 32 or more characters).
   */
  #push(value: string, minLength = 12): void {
    if (value.length >= minLength && !this.#secrets.includes(value)) {
      this.#secrets.push(value);
    }
  }

  scrub(text: string): string {
    let out = text;
    for (const secret of this.#secrets) {
      out = out.split(secret).join("[redacted]");
    }
    return out;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
