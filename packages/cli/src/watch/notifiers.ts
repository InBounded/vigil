import type { Locale } from "@vigil-sol/core";
import { CliError } from "../errors.js";
import { m } from "../messages.js";
import { type Alert, alertLine, alertLines, alertPlainText, fit } from "./alert.js";
import { type NotifierHttp, NotifierTransportError } from "./transport.js";

export type NotifierId = "discord" | "telegram" | "stdout";

export type SendResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Worth trying again (429, 5xx, network); a 4xx refusal is not. */
      readonly retryable: boolean;
      readonly retryAfterMs: number | null;
      /** Why, without any URL or token. */
      readonly reason: string;
    };

export interface Notifier {
  readonly id: NotifierId;
  send(alert: Alert): Promise<SendResult>;
}

/**
 * Discord `content` limit: "up to 2000 characters" (Execute Webhook, docs.discord.com, checked
 * 2026-09-23). Counted here in UTF-16 code units, which is never fewer than characters.
 */
export const DISCORD_CONTENT_LIMIT = 2000;
/** Telegram `sendMessage` `text`: "1-4096 characters after entities parsing" (core.telegram.org/bots/api). */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** Discord message flag `SUPPRESS_EMBEDS` = `1 << 2` (no link preview card). */
const SUPPRESS_EMBEDS = 1 << 2;

const DISCORD_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "canary.discord.com",
  "ptb.discord.com",
]);
const DISCORD_PATH = /^\/api(\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;
const TELEGRAM_TOKEN = /^\d+:[A-Za-z0-9_-]+$/;
const TELEGRAM_CHAT = /^(-?\d+|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

/**
 * Discord: the alert as plain `content`. Only Vigil's own headline is outside the code block;
 * everything that can hold on-chain text is inside it, where Discord renders no Markdown, no
 * masked links and no mentions (backticks are replaced so the block cannot be closed early).
 * `allowed_mentions: { parse: [] }` is the documented way to suppress every mention, as a second
 * barrier against `@everyone` in a token name.
 */
export class DiscordNotifier implements Notifier {
  readonly id = "discord";
  readonly #url: string;
  readonly #http: NotifierHttp;
  readonly #locale: Locale;

  constructor(url: string, http: NotifierHttp, locale: Locale) {
    this.#url = url;
    this.#http = http;
    this.#locale = locale;
  }

  async send(alert: Alert): Promise<SendResult> {
    const content = discordContent(alert, this.#locale);
    try {
      const response = await this.#http.post(`${this.#url}?wait=true`, {
        allowed_mentions: { parse: [] },
        content,
        flags: SUPPRESS_EMBEDS,
      });
      if (response.status >= 200 && response.status < 300) {
        return { ok: true };
      }
      return failure(
        "Discord",
        response.status,
        response.retryAfterSeconds ?? retryAfterFromBody(response.body, "discord"),
      );
    } catch (error) {
      return transportFailure("Discord", error);
    }
  }
}

export function discordContent(alert: Alert, locale: Locale): string {
  const { title, body } = alertLines(alert, locale);
  const unfence = (line: string) => line.replaceAll("`", "'");
  // The title is Vigil's own text (headline + index), never on-chain data.
  const head = [`**${title}**`, "```text"];
  const tail = [
    "```",
    ...(alert.permalink === null ? [] : [m(locale, "alert.link", { url: alert.permalink })]),
  ];
  return fit(head, body.map(unfence), tail, DISCORD_CONTENT_LIMIT, locale);
}

/** Telegram: plain text only. No `parse_mode`, so nothing in the text is interpreted as markup. */
export class TelegramNotifier implements Notifier {
  readonly id = "telegram";
  readonly #token: string;
  readonly #chatId: string;
  readonly #http: NotifierHttp;
  readonly #locale: Locale;

  constructor(token: string, chatId: string, http: NotifierHttp, locale: Locale) {
    this.#token = token;
    this.#chatId = chatId;
    this.#http = http;
    this.#locale = locale;
  }

  async send(alert: Alert): Promise<SendResult> {
    try {
      const response = await this.#http.post(
        `https://api.telegram.org/bot${this.#token}/sendMessage`,
        {
          chat_id: this.#chatId,
          link_preview_options: { is_disabled: true },
          text: alertPlainText(alert, this.#locale, TELEGRAM_TEXT_LIMIT),
        },
      );
      if (response.status >= 200 && response.status < 300 && telegramOk(response.body)) {
        return { ok: true };
      }
      return failure(
        "Telegram",
        response.status,
        retryAfterFromBody(response.body, "telegram") ?? response.retryAfterSeconds,
      );
    } catch (error) {
      return transportFailure("Telegram", error);
    }
  }
}

/** Standard output: one readable line per alert, or one JSON line with `--json`. */
export class StdoutNotifier implements Notifier {
  readonly id = "stdout";
  readonly #write: (text: string) => void;
  readonly #json: boolean;
  readonly #locale: Locale;

  constructor(write: (text: string) => void, json: boolean, locale: Locale) {
    this.#write = write;
    this.#json = json;
    this.#locale = locale;
  }

  send(alert: Alert): Promise<SendResult> {
    this.#write(`${this.#json ? JSON.stringify(alert) : alertLine(alert, this.#locale)}\n`);
    return Promise.resolve({ ok: true });
  }
}

function telegramOk(body: string): boolean {
  try {
    return (JSON.parse(body) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/** Discord: `retry_after` (seconds, float). Telegram: `parameters.retry_after` (seconds). */
function retryAfterFromBody(body: string, service: "discord" | "telegram"): number | null {
  try {
    const parsed = JSON.parse(body) as {
      retry_after?: unknown;
      parameters?: { retry_after?: unknown };
    };
    const value = service === "discord" ? parsed.retry_after : parsed.parameters?.retry_after;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function failure(service: string, status: number, retryAfterSeconds: number | null): SendResult {
  const retryable = status === 429 || status >= 500;
  return {
    ok: false,
    reason: `${service} answered HTTP ${status}${status === 404 ? " (the webhook or bot no longer exists)" : ""}`,
    retryAfterMs: retryAfterSeconds === null ? null : Math.ceil(retryAfterSeconds * 1000),
    retryable,
  };
}

function transportFailure(service: string, error: unknown): SendResult {
  return {
    ok: false,
    reason: `${service}: ${error instanceof NotifierTransportError ? error.message : "request failed"}`,
    retryAfterMs: null,
    retryable: true,
  };
}

export interface RetryPolicy {
  readonly attempts: number;
  readonly baseDelayMs: number;
  /** A server asking to wait longer than this is left for the next cycle. */
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseDelayMs: 1000, maxDelayMs: 60_000 };

/**
 * Sends with exponential backoff and jitter (1 s, 2 s, 4 s… up to `maxDelayMs`), honouring a
 * server's `retry_after`. Stops early on a refusal that retrying cannot fix.
 */
export async function sendWithRetry(
  notifier: Notifier,
  alert: Alert,
  sleep: (ms: number) => Promise<void>,
  policy: RetryPolicy = DEFAULT_RETRY,
  random: () => number = Math.random,
): Promise<SendResult> {
  let last: SendResult = { ok: false, reason: "not sent", retryAfterMs: null, retryable: true };
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    last = await notifier.send(alert);
    if (last.ok || !last.retryable || attempt === policy.attempts - 1) {
      return last;
    }
    const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
    const delay = last.retryAfterMs ?? Math.round(backoff * (0.5 + random() * 0.5));
    if (delay > policy.maxDelayMs) {
      return last;
    }
    await sleep(delay);
  }
  return last;
}

export interface NotifierSetup {
  readonly notifiers: readonly Notifier[];
  /** Values to redact from every output (webhook URL, bot token). */
  readonly secrets: readonly string[];
}

/**
 * The notifiers configured by environment variables (never by flags: the webhook URL and the bot
 * token are secrets). Standard output is always one of them.
 */
export function notifiersFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  http: NotifierHttp,
  stdout: StdoutNotifier,
  locale: Locale,
): NotifierSetup {
  const notifiers: Notifier[] = [stdout];
  const secrets: string[] = [];
  const webhook = env.VIGIL_DISCORD_WEBHOOK?.trim();
  if (webhook !== undefined && webhook !== "") {
    secrets.push(webhook);
    notifiers.push(new DiscordNotifier(checkDiscordWebhook(webhook), http, locale));
  }
  const token = env.VIGIL_TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.VIGIL_TELEGRAM_CHAT_ID?.trim();
  const hasToken = token !== undefined && token !== "";
  const hasChat = chat !== undefined && chat !== "";
  if (hasToken !== hasChat) {
    throw new CliError(
      "Telegram needs both VIGIL_TELEGRAM_BOT_TOKEN and VIGIL_TELEGRAM_CHAT_ID.",
      "Set both variables, or neither to turn Telegram alerts off.",
    );
  }
  if (hasToken && hasChat) {
    secrets.push(token);
    if (!TELEGRAM_TOKEN.test(token)) {
      throw new CliError(
        "VIGIL_TELEGRAM_BOT_TOKEN does not look like a bot token (<digits>:<letters, digits, _ or ->).",
        "Copy the token BotFather gave you.",
      );
    }
    if (!TELEGRAM_CHAT.test(chat)) {
      throw new CliError(
        "VIGIL_TELEGRAM_CHAT_ID must be a numeric chat id (e.g. -1001234567890) or @channelusername.",
      );
    }
    notifiers.push(new TelegramNotifier(token, chat, http, locale));
  }
  return { notifiers, secrets };
}

function checkDiscordWebhook(value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (
    url === undefined ||
    url.protocol !== "https:" ||
    !DISCORD_HOSTS.has(url.hostname) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !DISCORD_PATH.test(url.pathname)
  ) {
    throw new CliError(
      "VIGIL_DISCORD_WEBHOOK is not a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>).",
      "Copy the URL from the channel's Integrations → Webhooks → Copy Webhook URL.",
    );
  }
  return `${url.origin}${url.pathname}`;
}

/**
 * `VIGIL_WEB_URL`: where the Vigil web app is hosted, for links in alerts. No default (nothing is
 * deployed yet). https only, except a local http address for testing; no query, fragment or
 * credentials (the route is appended as a fragment).
 */
export function checkWebUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }
  let url: URL | undefined;
  try {
    url = new URL(trimmed);
  } catch {
    url = undefined;
  }
  const local = url !== undefined && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    url === undefined ||
    !(url.protocol === "https:" || (url.protocol === "http:" && local)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new CliError(
      "VIGIL_WEB_URL must be the https:// address of a Vigil web app, without a query or #fragment.",
      "Example: VIGIL_WEB_URL=https://vigil.example.org",
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}
