/**
 * `vigil watch --once` replayed over real recorded cycles, in order, with one state file: each
 * alert must be sent exactly once to every notifier (stdout, and Discord and Telegram through a
 * local fake server). The fixtures are what the watch cycle read live, recorded by
 * scripts/devnet-watch-sequence.ts (local test validator: created → approved → executed) and
 * scripts/capture-watch.ts (mainnet).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, startFakeServer } from "./test-support/fake-server.js";
import { NOW, run } from "./test-support/harness.js";
import type { Alert } from "./watch/alert.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${"w".repeat(68)}`;
const BOT_TOKEN = `123456789:${"T".repeat(35)}`;

let dir: string;
let server: FakeServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vigil-watch-seq-"));
  server = await startFakeServer();
});

afterEach(async () => {
  await server.close();
  await rm(dir, { force: true, recursive: true });
});

/** The file of a recorded cycle, gzipped or not. */
function cycleFile(base: string): string {
  return existsSync(`${base}.json`) ? `${base}.json` : `${base}.json.gz`;
}

/** Runs `vigil watch --once --json` on each recorded cycle in order; returns the alerts per cycle. */
async function replay(
  multisig: string,
  bases: readonly string[],
  /** How the RPC is chosen: `--cluster mainnet` (public endpoint's host) or the local validator's endpoint. */
  endpoint: readonly string[],
): Promise<Alert[][]> {
  const perCycle: Alert[][] = [];
  for (const base of bases) {
    const result = await run(
      ["watch", multisig, "--once", "--json", ...endpoint, "--state-file", join(dir, "state.json")],
      {
        env: {
          NODE_ENV: "test",
          VIGIL_DISCORD_WEBHOOK: WEBHOOK,
          VIGIL_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
          VIGIL_TELEGRAM_CHAT_ID: "-1001234567890",
          VIGIL_TEST_FIXTURES: cycleFile(base),
          VIGIL_TEST_HTTP_FIXTURE: `${base}.http.json`,
          VIGIL_TEST_NOTIFY_ORIGIN: server.origin,
          VIGIL_TEST_NOW: NOW,
          VIGIL_WEB_URL: "https://vigil.example.org",
        },
      },
    );
    expect(result.code, result.stderr).toBe(0);
    perCycle.push(
      result.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Alert),
    );
  }
  return perCycle;
}

function summary(alert: Alert): string {
  return `#${alert.transactionIndex} ${alert.status.from === undefined ? "new" : `${alert.status.from}>`}${alert.status.to}`;
}

/** Every alert reached Discord and Telegram exactly once. */
function expectEachDeliveredOnce(alerts: readonly Alert[]): void {
  const discord = server.requests.filter((r) => r.path.startsWith("/discord.com/"));
  const telegram = server.requests.filter((r) => r.path.startsWith("/api.telegram.org/"));
  expect(discord).toHaveLength(alerts.length);
  expect(telegram).toHaveLength(alerts.length);
  alerts.forEach((alert, i) => {
    const content = String((JSON.parse(discord[i]?.body ?? "{}") as { content?: unknown }).content);
    const text = String((JSON.parse(telegram[i]?.body ?? "{}") as { text?: unknown }).text);
    expect(content).toContain(`#${alert.transactionIndex}`);
    expect(text).toContain(`#${alert.transactionIndex}`);
  });
}

/**
 * Recorded on a LOCAL TEST VALIDATOR (solana-test-validator 4.2.2, Squads v4 program and its
 * ProgramConfig cloned from devnet), not on devnet itself: the devnet faucet was rate-limited. The
 * account bytes are real program output; the cluster is "unknown" to Vigil (a local genesis hash),
 * so alerts carry no web-app link. See docs/DECISIONS.md.
 */
const LOCAL = join(FIXTURES, "watch-local", "local-sequence");
const LOCAL_RPC = ["--rpc", "http://127.0.0.1:8899"];

describe("local validator: one proposal created → approved → executed", () => {
  const multisig = (): string => {
    const description = (
      JSON.parse(readFileSync(`${LOCAL}-000.json`, "utf8")) as { description: string }
    ).description;
    const match = /multisig ([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(description);
    if (match?.[1] === undefined) {
      throw new Error("multisig address not in the fixture description");
    }
    return match[1];
  };

  it("alerts once on creation, once on approval (re-analysed), once on execution, then never again", async () => {
    const bases = [0, 1, 2, 3, 4, 4].map((i) => `${LOCAL}-${String(i).padStart(3, "0")}`);
    const cycles = await replay(multisig(), bases, LOCAL_RPC);
    expect(cycles.map((alerts) => alerts.map(summary))).toEqual([
      [], // multisig created, nothing proposed
      ["#1 newActive"], // proposed
      [], // 1 of 2 approvals: nothing to say
      ["#1 Active>Approved"], // 2 of 2: ready to execute
      ["#1 Approved>Executed"],
      [], // the same chain state again
    ]);
    const [created, approved, executed] = [cycles[1]?.[0], cycles[3]?.[0], cycles[4]?.[0]];
    expect(created).toMatchObject({
      cluster: "unknown",
      initial: false,
      rpcHost: "127.0.0.1:8899",
      verdictSource: "analysis",
    });
    expect(created?.instructions.join(" ")).toContain("0.001 SOL");
    expect(approved).toMatchObject({ verdictSource: "analysis" });
    expect(executed).toMatchObject({ verdict: approved?.verdict, verdictSource: "last-known" });
    for (const alert of [created, approved, executed]) {
      // The web app knows mainnet and devnet only: no link for an unknown cluster.
      expect(alert?.permalink).toBeNull();
    }
    expectEachDeliveredOnce(cycles.flat());
    const approvedDiscord = server.requests.filter((r) => r.path.startsWith("/discord.com/"))[1];
    expect(approvedDiscord?.body).toContain("approved: ready to execute");
  });
});

describe("mainnet: real cycles of 6TXHbBaU… (a skipped step included)", () => {
  it("first run, #12 executed, #13 created, #13 Active → Executed: each alert once", async () => {
    const base = join(FIXTURES, "watch", "6TXHbBaU");
    const bases = [0, 1, 2, 3, 3].map((i) => `${base}-${String(i).padStart(3, "0")}`);
    const cycles = await replay("6TXHbBaU8rRk3yJAY42RMymtzoTQFRfz3TKGuALiPqqA", bases, [
      "--cluster",
      "mainnet",
    ]);
    expect(cycles.map((alerts) => alerts.map(summary))).toEqual([
      ["#5 newApproved", "#7 newApproved", "#11 newApproved", "#12 newApproved"],
      ["#12 Approved>Executed"],
      ["#13 newActive"],
      ["#13 Active>Executed"],
      [],
    ]);
    expect(cycles[0]?.every((alert) => alert.initial)).toBe(true);
    expect(cycles[3]?.[0]).toMatchObject({
      verdict: cycles[2]?.[0]?.verdict,
      verdictSource: "last-known",
    });
    expectEachDeliveredOnce(cycles.flat());
  });
});
