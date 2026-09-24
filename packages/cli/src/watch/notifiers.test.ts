import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type AnalysisReport,
  analyzeRawTransaction,
  FixtureRpcClient,
  type WatchEvent,
} from "@vigil-sol/core";
import { loadFixtureFiles } from "@vigil-sol/core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureMode } from "../fixture-mode.js";
import { type FakeServer, startFakeServer } from "../test-support/fake-server.js";
import { type Alert, alertPlainText, buildAlert } from "./alert.js";
import {
  checkWebUrl,
  DISCORD_CONTENT_LIMIT,
  DiscordNotifier,
  discordContent,
  notifiersFromEnv,
  StdoutNotifier,
  sendWithRetry,
  TELEGRAM_TEXT_LIMIT,
  TelegramNotifier,
} from "./notifiers.js";
import { fetchNotifierHttp } from "./transport.js";

const WEB = fileURLToPath(new URL("../../../../fixtures/web/", import.meta.url));
const MULTISIG = "81S2mzdgrTGVjHHiJGiN2bCt8hjaiBvoNqVmYyRVzuJf";
const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${"a".repeat(68)}`;
const BOT_TOKEN = `123456789:${"B".repeat(35)}`;
const NOW = "2026-09-23T12:00:00.000Z";

/** The real hostile-memo report (crafted memo text, real RPC answers and simulation). */
async function hostileReport(): Promise<AnalysisReport> {
  const mode = await fixtureMode({
    NODE_ENV: "test",
    VIGIL_TEST_FIXTURES: `${WEB}hostile-memo.json`,
    VIGIL_TEST_HTTP_FIXTURE: `${WEB}hostile-memo.http.json`,
    VIGIL_TEST_NOW: NOW,
  });
  if (mode === undefined) {
    throw new Error("fixture mode off");
  }
  const base64 = (await readFile(`${WEB}hostile-memo.base64`, "utf8")).trim();
  return analyzeRawTransaction(
    {
      clock: mode.clock ?? { now: () => Date.parse(NOW) },
      http: mode.createHttp(),
      rpc: new FixtureRpcClient(await loadFixtureFiles([`${WEB}hostile-memo.json`])),
      rpcHost: "api.mainnet-beta.solana.com",
    },
    base64,
  );
}

const EVENT: WatchEvent = {
  initial: false,
  isStale: false,
  kind: "new-proposal",
  status: "Active",
  transactionIndex: 12n,
  transactionKind: "vault",
};

function context(webUrl: string | undefined = "https://vigil.example.org") {
  return {
    cluster: "mainnet",
    detectedAt: NOW,
    locale: "en" as const,
    multisig: MULTISIG,
    rpcHost: "api.mainnet-beta.solana.com",
    timeLockSeconds: 0,
    webUrl,
  };
}

let alert: Alert;
let server: FakeServer;

beforeEach(async () => {
  alert ??= buildAlert(EVENT, { kind: "report", report: await hostileReport() }, context());
  server = await startFakeServer();
});

afterEach(async () => {
  await server.close();
});

function http() {
  return fetchNotifierHttp({ NODE_ENV: "test", VIGIL_TEST_NOTIFY_ORIGIN: server.origin });
}

const noSleep = () => Promise.resolve();

describe("alert content from a real report with hostile on-chain text", () => {
  it("keeps the memo as visible text, with every invisible and bidi character removed", () => {
    const text = alertPlainText(alert, "en", TELEGRAM_TEXT_LIMIT);
    expect(text).toContain("<script>");
    expect(text).toContain("pay USDC");
    for (const invisible of [
      "\u202e",
      "\u200b",
      "\u2066",
      "\u2069",
      "\u200f",
      "\u2060",
      "\ufeff",
    ]) {
      expect(text).not.toContain(invisible);
    }
    expect(text).not.toMatch(/\udb40\udc41/);
    expect(text).toContain("Details: https://vigil.example.org/#/ms/");
    expect(text).toContain("RPC api.mainnet-beta.solana.com");
  });
});

describe("DiscordNotifier against a fake server", () => {
  it("posts plain content with mentions suppressed, on-chain text inside a code block", async () => {
    const result = await new DiscordNotifier(WEBHOOK, http(), "en").send(alert);
    expect(result).toEqual({ ok: true });
    const [request] = server.requests;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe(
      `/discord.com/api/webhooks/123456789012345678/${"a".repeat(68)}?wait=true`,
    );
    expect(request?.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.flags).toBe(4);
    expect(Object.keys(body).sort()).toEqual(["allowed_mentions", "content", "flags"]);
    const content = String(body.content);
    const lines = content.split("\n");
    expect(lines[0]).toBe("**Vigil · New proposal #12 (Active)**");
    expect(lines[1]).toBe("```text");
    const close = lines.indexOf("```", 2);
    expect(close).toBeGreaterThan(2);
    // Everything from the report sits between the fences.
    const inside = lines.slice(2, close).join("\n");
    expect(inside).toContain("<script>");
    expect(lines.slice(close + 1).join("\n")).toBe(
      `Details: https://vigil.example.org/#/ms/${MULTISIG}/12`,
    );
  });

  it("cannot be broken out of its code block, and stays within 2000 characters", () => {
    const hostile: Alert = {
      ...alert,
      findings: [
        {
          ruleId: "VGL-W001",
          severity: "warning",
          title: "```\n@everyone [claim](https://x.test) <@&1>",
        },
      ],
      findingsTotal: 1,
      instructions: Array.from(
        { length: 5 },
        () => `Memo: ${"`".repeat(3)} @here ${"x".repeat(600)}`,
      ),
      instructionsTotal: 40,
    };
    const content = discordContent(hostile, "en");
    expect(content.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(content.match(/```/g)).toHaveLength(2);
    expect(content).toContain("cut to fit the message limit");
    expect(content.endsWith(`Details: https://vigil.example.org/#/ms/${MULTISIG}/12`)).toBe(true);
  });

  it("429 with retry_after: waits what Discord asks, then succeeds", async () => {
    server.script.push({
      body: '{"message":"rate limited","retry_after":1.5,"global":false}',
      status: 429,
    });
    const waits: number[] = [];
    const result = await sendWithRetry(new DiscordNotifier(WEBHOOK, http(), "en"), alert, (ms) => {
      waits.push(ms);
      return Promise.resolve();
    });
    expect(result).toEqual({ ok: true });
    expect(waits).toEqual([1500]);
    expect(server.requests).toHaveLength(2);
  });

  it("5xx: backs off exponentially and gives up after 4 attempts, without the token in the reason", async () => {
    server.fallback = { body: "oops", status: 503 };
    const waits: number[] = [];
    const result = await sendWithRetry(
      new DiscordNotifier(WEBHOOK, http(), "en"),
      alert,
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      undefined,
      () => 1,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "Discord answered HTTP 503",
      retryable: true,
    });
    expect(server.requests).toHaveLength(4);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(JSON.stringify(result)).not.toContain("a".repeat(20));
  });

  it("404 is not retried (Discord asks not to reuse a deleted webhook)", async () => {
    server.fallback = { body: '{"message":"Unknown Webhook"}', status: 404 };
    const result = await sendWithRetry(new DiscordNotifier(WEBHOOK, http(), "en"), alert, noSleep);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(server.requests).toHaveLength(1);
  });

  it("a server asking to wait longer than a minute is left for the next cycle", async () => {
    server.script.push({ body: '{"retry_after":3600}', status: 429 });
    const result = await sendWithRetry(new DiscordNotifier(WEBHOOK, http(), "en"), alert, noSleep);
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(server.requests).toHaveLength(1);
  });
});

describe("TelegramNotifier against a fake server", () => {
  it("posts plain text: no parse_mode, link previews off", async () => {
    const result = await new TelegramNotifier(BOT_TOKEN, "-1001234567890", http(), "en").send(
      alert,
    );
    expect(result).toEqual({ ok: true });
    const [request] = server.requests;
    expect(request?.path).toBe(`/api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["chat_id", "link_preview_options", "text"]);
    expect(body.parse_mode).toBeUndefined();
    expect(body.chat_id).toBe("-1001234567890");
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    expect(String(body.text)).toBe(alertPlainText(alert, "en", TELEGRAM_TEXT_LIMIT));
  });

  it("cuts to 4096 characters", async () => {
    const long: Alert = {
      ...alert,
      instructions: Array.from({ length: 5 }, () => "é".repeat(1500)),
    };
    await new TelegramNotifier(BOT_TOKEN, "@vigil_alerts", http(), "en").send(long);
    const text = String((JSON.parse(server.requests[0]?.body ?? "{}") as { text?: unknown }).text);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(text).toContain("cut to fit the message limit");
  });

  it("an answer with ok: false is a failure; 429 honours parameters.retry_after", async () => {
    server.script.push({
      body: '{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":7}}',
      status: 429,
    });
    server.script.push({
      body: '{"ok":false,"error_code":400,"description":"chat not found"}',
      status: 200,
    });
    const waits: number[] = [];
    const result = await sendWithRetry(
      new TelegramNotifier(BOT_TOKEN, "-1", http(), "en"),
      alert,
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    );
    expect(waits).toEqual([7000]);
    expect(result).toMatchObject({ ok: false, reason: "Telegram answered HTTP 200" });
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
  });

  it("a network failure is retryable and its reason holds no URL", async () => {
    await server.close();
    server = await startFakeServer();
    const dead = fetchNotifierHttp({
      NODE_ENV: "test",
      VIGIL_TEST_NOTIFY_ORIGIN: "http://127.0.0.1:1",
    });
    const result = await new TelegramNotifier(BOT_TOKEN, "-1", dead, "en").send(alert);
    expect(result).toEqual({
      ok: false,
      reason: "Telegram: network error",
      retryAfterMs: null,
      retryable: true,
    });
  });
});

describe("configuration from the environment", () => {
  const stdout = new StdoutNotifier(() => undefined, false, "en");

  it("stdout always; Discord and Telegram when configured", () => {
    expect(notifiersFromEnv({}, http(), stdout, "en").notifiers.map((n) => n.id)).toEqual([
      "stdout",
    ]);
    const setup = notifiersFromEnv(
      {
        VIGIL_DISCORD_WEBHOOK: WEBHOOK,
        VIGIL_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        VIGIL_TELEGRAM_CHAT_ID: "-1",
      },
      http(),
      stdout,
      "en",
    );
    expect(setup.notifiers.map((n) => n.id)).toEqual(["stdout", "discord", "telegram"]);
    expect(setup.secrets).toEqual([WEBHOOK, BOT_TOKEN]);
  });

  it.each([
    ["http", WEBHOOK.replace("https:", "http:")],
    ["another host", WEBHOOK.replace("discord.com", "discord.com.evil.test")],
    ["a query", `${WEBHOOK}?thread_id=1`],
    ["not a webhook path", "https://discord.com/api/users/1/abc"],
    ["credentials", WEBHOOK.replace("https://", "https://u:p@")],
  ])("refuses a Discord webhook with %s, without printing it", (_name, value) => {
    expect(() => notifiersFromEnv({ VIGIL_DISCORD_WEBHOOK: value }, http(), stdout, "en")).toThrow(
      /not a Discord webhook URL/,
    );
    try {
      notifiersFromEnv({ VIGIL_DISCORD_WEBHOOK: value }, http(), stdout, "en");
    } catch (error) {
      expect(String(error)).not.toContain("a".repeat(20));
    }
  });

  it("Telegram needs both variables and well-formed values", () => {
    expect(() =>
      notifiersFromEnv({ VIGIL_TELEGRAM_BOT_TOKEN: BOT_TOKEN }, http(), stdout, "en"),
    ).toThrow(/needs both/);
    expect(() =>
      notifiersFromEnv(
        { VIGIL_TELEGRAM_BOT_TOKEN: "nope", VIGIL_TELEGRAM_CHAT_ID: "-1" },
        http(),
        stdout,
        "en",
      ),
    ).toThrow(/bot token/);
    expect(() =>
      notifiersFromEnv(
        { VIGIL_TELEGRAM_BOT_TOKEN: BOT_TOKEN, VIGIL_TELEGRAM_CHAT_ID: "x y" },
        http(),
        stdout,
        "en",
      ),
    ).toThrow(/chat id/);
  });

  it("VIGIL_WEB_URL: https (or local http), no query or fragment; permalinks per cluster", () => {
    expect(checkWebUrl(undefined)).toBeUndefined();
    expect(checkWebUrl("https://vigil.example.org/app/")).toBe("https://vigil.example.org/app");
    expect(checkWebUrl("http://localhost:5173")).toBe("http://localhost:5173");
    for (const bad of [
      "http://vigil.example.org",
      "https://v.example/?a=1",
      "https://v.example/#/x",
      "ftp://v",
    ]) {
      expect(() => checkWebUrl(bad)).toThrow(/VIGIL_WEB_URL/);
    }
    const devnet = buildAlert(
      EVENT,
      { kind: "last-known", verdict: undefined },
      { ...context(), cluster: "devnet" },
    );
    expect(devnet.permalink).toBe(`https://vigil.example.org/#/ms/${MULTISIG}/12?cluster=devnet`);
    const unknown = buildAlert(
      EVENT,
      { kind: "last-known", verdict: undefined },
      { ...context(), cluster: "unknown" },
    );
    expect(unknown.permalink).toBeNull();
    expect(
      buildAlert(
        EVENT,
        { kind: "last-known", verdict: undefined },
        { ...context(), webUrl: undefined },
      ).permalink,
    ).toBeNull();
  });

  it("the test redirect only points at this machine and only in test mode", async () => {
    expect(() =>
      fetchNotifierHttp({ NODE_ENV: "test", VIGIL_TEST_NOTIFY_ORIGIN: "http://evil.test" }),
    ).toThrow();
    // Outside test mode the variable is ignored: the request goes to the real host, which this
    // stub fetch records instead of calling.
    const seen: string[] = [];
    const transport = fetchNotifierHttp({ VIGIL_TEST_NOTIFY_ORIGIN: server.origin }, (url) => {
      seen.push(url);
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    await transport.post(WEBHOOK, {});
    expect(seen).toEqual([WEBHOOK]);
    expect(server.requests).toHaveLength(0);
  });
});
