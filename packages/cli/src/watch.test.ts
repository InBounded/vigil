import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcClient } from "@vigil-sol/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, startFakeServer } from "./test-support/fake-server.js";
import { NOW, run } from "./test-support/harness.js";
import type { Alert } from "./watch/alert.js";

const WEB = fileURLToPath(new URL("../../../fixtures/web/", import.meta.url));
/** Real mainnet multisig; `multisig-list` holds its last 50 indices, #2267 and #2268 pending. */
const MULTISIG = "81S2mzdgrTGVjHHiJGiN2bCt8hjaiBvoNqVmYyRVzuJf";
const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${"w".repeat(68)}`;
const BOT_TOKEN = `123456789:${"T".repeat(35)}`;
const KEYED_RPC = "https://rpc.example.com/v2/secretkey0123456789abcdef";

const LIST_ENV = {
  NODE_ENV: "test",
  VIGIL_TEST_FIXTURES: `${WEB}multisig-list.json`,
  VIGIL_TEST_HTTP_FIXTURE: `${WEB}multisig-list.http.json`,
  VIGIL_TEST_NOW: NOW,
};

let dir: string;
let server: FakeServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vigil-watch-"));
  server = await startFakeServer();
});

afterEach(async () => {
  await server.close();
  await rm(dir, { force: true, recursive: true });
});

function stateFile(): string {
  return join(dir, "state.json");
}

async function readState(path = stateFile()): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function jsonLines(stdout: string): Alert[] {
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Alert);
}

describe("vigil watch --once, first run on a real multisig", () => {
  it("alerts on the proposals already pending, analysed, then stays quiet on the same chain state", async () => {
    const first = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: LIST_ENV,
    });
    expect(first.stderr).toContain("no state yet: alerting on proposals that are already pending");
    expect(first.code).toBe(0);
    const lines = first.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Pending proposal #2267 (Draft)");
    expect(lines[1]).toContain("Pending proposal #2268 (Draft)");
    expect(lines[0]).toContain(`${MULTISIG} (mainnet)`);
    expect(lines[0]).toMatch(/NEEDS ATTENTION|ANALYSIS INCOMPLETE|CRITICAL|NO FINDINGS/);

    const state = await readState();
    expect(state.outbox).toEqual([]);
    const watch = state.watch as {
      lastTransactionIndex: string;
      tracked: { transactionIndex: string }[];
    };
    expect(watch.lastTransactionIndex).toBe("2276");
    expect(watch.tracked.map((t) => t.transactionIndex)).toEqual(["2267", "2268"]);
    expect(Object.keys(state.verdicts as object)).toEqual(["2267", "2268"]);

    const second = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: LIST_ENV,
    });
    expect(second.code).toBe(0);
    expect(second.stdout).toBe("");
  });

  it("--json: one JSON alert per line, with verdict, findings, instructions and link, no RPC URL", async () => {
    const result = await run(["watch", MULTISIG, "--once", "--json", "--state-file", stateFile()], {
      env: { ...LIST_ENV, VIGIL_RPC_URL: KEYED_RPC, VIGIL_WEB_URL: "https://vigil.example.org" },
    });
    expect(result.code).toBe(0);
    const alerts = jsonLines(result.stdout);
    expect(alerts.map((a) => a.transactionIndex)).toEqual(["2267", "2268"]);
    for (const alert of alerts) {
      expect(alert).toMatchObject({
        cluster: "mainnet",
        event: "new-proposal",
        initial: true,
        multisig: MULTISIG,
        rpcHost: "rpc.example.com",
        schemaVersion: 1,
        status: { to: "Draft" },
        verdictSource: "analysis",
      });
      expect(alert.verdict).not.toBeNull();
      expect(alert.findings.length).toBeLessThanOrEqual(3);
      expect(alert.findingsTotal).toBeGreaterThanOrEqual(alert.findings.length);
      expect(alert.instructions.length).toBeGreaterThan(0);
      expect(alert.permalink).toBe(
        `https://vigil.example.org/#/ms/${MULTISIG}/${alert.transactionIndex}`,
      );
    }
    for (const text of [result.stdout, result.stderr, await readFile(stateFile(), "utf8")]) {
      expect(text).not.toContain("secretkey0123456789abcdef");
      expect(text).not.toContain(KEYED_RPC);
    }
  });

  it("without VIGIL_WEB_URL: no link, and a note once on stderr", async () => {
    const result = await run(["watch", MULTISIG, "--once", "--json", "--state-file", stateFile()], {
      env: LIST_ENV,
    });
    expect(jsonLines(result.stdout).every((a) => a.permalink === null)).toBe(true);
    expect(result.stderr.match(/VIGIL_WEB_URL is not set/g)).toHaveLength(1);
  });
});

describe("delivery: retries, the outbox, and exactly once per notifier", () => {
  const env = (extra: Record<string, string> = {}) => ({
    ...LIST_ENV,
    VIGIL_DISCORD_WEBHOOK: WEBHOOK,
    VIGIL_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    VIGIL_TELEGRAM_CHAT_ID: "-1001234567890",
    VIGIL_TEST_NOTIFY_ORIGIN: server.origin,
    ...extra,
  });
  const discord = () => server.requests.filter((r) => r.path.startsWith("/discord.com/"));
  const telegram = () => server.requests.filter((r) => r.path.startsWith("/api.telegram.org/"));

  it("sends each alert once to Discord, Telegram and stdout", async () => {
    const result = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: env(),
    });
    expect(result.code).toBe(0);
    expect(discord()).toHaveLength(2);
    expect(telegram()).toHaveLength(2);
    expect(result.stdout.trim().split("\n")).toHaveLength(2);
    await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], { env: env() });
    expect(server.requests).toHaveLength(4);
  });

  it("a Discord outage: retried with backoff, kept in the state, delivered once on the next run; Telegram not repeated", async () => {
    // Discord answers 503 to everything in the first run; Telegram answers ok.
    server.handler = (request) =>
      request.path.startsWith("/discord.com/")
        ? { body: "unavailable", status: 503 }
        : { body: '{"ok":true}', status: 200 };

    const sleeps: number[] = [];
    const first = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: env(),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(first.code).toBe(3);
    expect(first.stderr).toContain("not delivered to discord: Discord answered HTTP 503");
    expect(first.stderr).not.toContain("w".repeat(20));
    expect(discord()).toHaveLength(8); // 2 alerts × 4 attempts
    expect(sleeps.length).toBe(6); // 3 backoffs per alert
    const state = await readState();
    expect((state.outbox as { pending: string[] }[]).map((item) => item.pending)).toEqual([
      ["discord"],
      ["discord"],
    ]);
    expect(first.stdout.trim().split("\n")).toHaveLength(2);
    const telegramBefore = telegram().length;
    expect(telegramBefore).toBe(2);

    server.handler = undefined;
    server.fallback = { body: "{}", status: 200 };
    const second = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: env(),
    });
    expect(second.code).toBe(0);
    expect(discord()).toHaveLength(10);
    expect(telegram()).toHaveLength(telegramBefore);
    expect(second.stdout).toBe("");
    expect((await readState()).outbox).toEqual([]);
  });

  it("an alert still undelivered after 24 hours is dropped, and says so", async () => {
    server.fallback = { body: "", status: 500 };
    await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: env({ VIGIL_TELEGRAM_BOT_TOKEN: "", VIGIL_TELEGRAM_CHAT_ID: "" }),
    });
    expect((await readState()).outbox).toHaveLength(2);
    const later = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: env({
        VIGIL_TELEGRAM_BOT_TOKEN: "",
        VIGIL_TELEGRAM_CHAT_ID: "",
        VIGIL_TEST_NOW: "2026-09-24T12:00:01.000Z",
      }),
    });
    expect(later.stderr).toContain("dropped after 24 hours without delivery to discord");
    expect((await readState()).outbox).toEqual([]);
  });

  it("an alert queued for a notifier that is no longer configured is dropped for it", async () => {
    server.fallback = { body: "", status: 500 };
    await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: env({ VIGIL_TELEGRAM_BOT_TOKEN: "", VIGIL_TELEGRAM_CHAT_ID: "" }),
    });
    const result = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: LIST_ENV,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("which is no longer configured; dropped for discord");
    expect((await readState()).outbox).toEqual([]);
  });

  it("no secret reaches stdout, stderr or the state file", async () => {
    server.fallback = { body: "", status: 500 };
    const result = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: env({ VIGIL_RPC_URL: KEYED_RPC }),
    });
    const texts = [result.stdout, result.stderr, await readFile(stateFile(), "utf8")];
    for (const text of texts) {
      for (const secret of [
        WEBHOOK,
        "w".repeat(20),
        BOT_TOKEN,
        "T".repeat(20),
        "secretkey0123456789abcdef",
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe("state file", () => {
  it("defaults to $XDG_STATE_HOME/vigil/<multisig>.json, else ~/.local/state/vigil/", async () => {
    await run(["watch", MULTISIG, "--once"], {
      env: { ...LIST_ENV, XDG_STATE_HOME: join(dir, "xdg") },
    });
    expect((await readState(join(dir, "xdg", "vigil", `${MULTISIG}.json`))).format).toBe(
      "vigil-watch-state",
    );

    await run(["watch", MULTISIG, "--once"], { env: LIST_ENV, homeDir: join(dir, "home") });
    const path = join(dir, "home", ".local", "state", "vigil", `${MULTISIG}.json`);
    expect((await readState(path)).format).toBe("vigil-watch-state");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "home", ".local", "state", "vigil"))).mode & 0o777).toBe(0o700);

    // A relative XDG_STATE_HOME is invalid per the XDG specification and ignored.
    await run(["watch", MULTISIG, "--once"], {
      env: { ...LIST_ENV, XDG_STATE_HOME: "relative" },
      homeDir: join(dir, "home2"),
    });
    expect(
      (await readState(join(dir, "home2", ".local", "state", "vigil", `${MULTISIG}.json`))).version,
    ).toBe(1);
  });

  it("no HOME and no XDG_STATE_HOME: asks for --state-file", async () => {
    const result = await run(["watch", MULTISIG, "--once"], { env: LIST_ENV });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Pass --state-file <path>.");
  });

  it("refuses a malformed state file, and one of another multisig or network", async () => {
    await writeFile(stateFile(), "{not json");
    let result = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: LIST_ENV,
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("The watch state file is not valid: not JSON.");

    await run(["watch", MULTISIG, "--once", "--state-file", join(dir, "ok.json")], {
      env: LIST_ENV,
    });
    const valid = await readState(join(dir, "ok.json"));
    const watch = valid.watch as Record<string, unknown>;

    await writeFile(
      stateFile(),
      JSON.stringify({ ...valid, watch: { ...watch, cluster: "devnet" } }),
    );
    result = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: LIST_ENV,
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("recorded on devnet, but the RPC is on mainnet");

    const other = "3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt";
    await writeFile(
      stateFile(),
      JSON.stringify({ ...valid, watch: { ...watch, multisig: other } }),
    );
    result = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: LIST_ENV,
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(`belongs to multisig ${other}`);

    const queued = {
      ...valid,
      outbox: [{ alert: { id: "x" }, pending: ["discord"], queuedAt: NOW }],
    };
    await writeFile(stateFile(), JSON.stringify(queued));
    result = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: LIST_ENV,
    });
    expect(result.stderr).toContain("a queued alert is malformed");
  });

  it("a state file that cannot be written stops the run before any alert is sent", async () => {
    const result = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: LIST_ENV,
      files: {
        read: () => Promise.resolve(undefined),
        write: () => Promise.reject(new Error("EACCES")),
      },
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("stopping so no alert is sent twice");
    expect(result.stdout).toBe("");
  });
});

describe("RPC failures and the long-running loop", () => {
  const failing = (): RpcClient => {
    const fail = () =>
      Promise.reject(
        new Error("fetch failed for https://rpc.example.com/v2/secretkey0123456789abcdef"),
      );
    return {
      getAccountInfo: fail,
      getGenesisHash: fail,
      getMultipleAccounts: fail,
      getSignaturesForAddress: fail,
      getSlot: fail,
      getTransaction: fail,
      limitations: () => [],
      simulateTransaction: fail,
    };
  };

  it("--once: an unreadable multisig is exit 3, the state untouched, the error without the URL", async () => {
    const result = await run(["watch", MULTISIG, "--once", "--state-file", stateFile()], {
      env: { ...LIST_ENV, VIGIL_RPC_URL: KEYED_RPC },
      rpc: failing,
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(
      "the multisig could not be read from the RPC (rpc.example.com)",
    );
    expect(result.stderr).not.toContain("secretkey");
  });

  it("reads every --interval seconds, alerts once, backs off after a failure, stops on the shutdown signal", async () => {
    const controller = new AbortController();
    const sleeps: number[] = [];
    let cycles = 0;
    const result = await run(["watch", MULTISIG, "--interval", "30", "--state-file", stateFile()], {
      env: LIST_ENV,
      shutdown: controller.signal,
      sleep: (ms) => {
        sleeps.push(ms);
        cycles++;
        if (cycles === 3) {
          controller.abort();
        }
        return Promise.resolve();
      },
    });
    expect(result.code).toBe(0);
    expect(sleeps).toEqual([30_000, 30_000, 30_000]);
    expect(result.stdout.trim().split("\n")).toHaveLength(2);
    expect(result.stderr).toContain("stopped");

    let calls = 0;
    const flaky = new AbortController();
    const waits: number[] = [];
    await run(["watch", MULTISIG, "--interval", "20", "--state-file", join(dir, "flaky.json")], {
      env: LIST_ENV,
      rpc: failing,
      shutdown: flaky.signal,
      sleep: (ms) => {
        waits.push(ms);
        calls++;
        if (calls === 3) {
          flaky.abort();
        }
        return Promise.resolve();
      },
    });
    expect(waits).toEqual([40_000, 80_000, 160_000]);
  });
});
