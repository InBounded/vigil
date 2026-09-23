/**
 * Program verification (Phase 5.2) against real OtterSec answers recorded verbatim in
 * `fixtures/http/verification-osec.json` (`scripts/capture-verification.ts`), and the programs'
 * real on-chain facts from `programs-mainnet.json.gz`.
 */
import { type Address, address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../io/http.js";
import type { ProgramInfo } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { failingHttp, loadRecordedHttp } from "../test-support/http.js";
import { loadFixture } from "../test-support/rules.js";
import { gatherProgramFacts } from "./gather.js";
import {
  addVerification,
  githubUrl,
  parseVerificationStatus,
  VERIFICATION_CACHE_TTL_MS,
  VERIFICATION_TIMEOUT_MS,
  VerificationCache,
} from "./verification.js";

const SQUADS_V3 = address("SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu");
const SETT1ERE = address("Sett1ereLzRw7neSzoUSwp6vvstBkEgAgQeP6wFcw5F");
const CPMM = address("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const J24J = address("J24jWEosQc5jgkdPm3YzNgzQ54CqNKkhzKy56XXJsLo2");
const SYSTEM = address("11111111111111111111111111111111");

let facts: readonly ProgramInfo[];
beforeAll(async () => {
  const data = await loadFixture("programs-mainnet.json.gz");
  facts = (
    await gatherProgramFacts(new FixtureRpcClient(data), {
      buffers: [],
      programs: [SQUADS_V3, SETT1ERE, CPMM, J24J, SYSTEM],
      vaults: [],
    })
  ).programs;
});

function clock(start = 1_800_000_000_000) {
  const state = { now: start };
  return { advance: (ms: number) => (state.now += ms), now: () => state.now };
}

const byAddress = (programs: readonly ProgramInfo[], a: Address) =>
  programs.find((p) => p.address === a);

describe("addVerification with real API answers", () => {
  it("maps verified and unverified programs, keeping only safe links", async () => {
    const http = await loadRecordedHttp("http/verification-osec");
    const result = await addVerification(facts, {
      cache: new VerificationCache(clock()),
      enabled: true,
      http,
    });
    expect(result.gaps).toEqual([]);
    expect(byAddress(result.programs, SQUADS_V3)).toMatchObject({
      verification: "verified",
      verificationDetails: {
        commit: "c95b7673d616c377a349ca424261872dfcf8b19d",
        lastVerifiedAt: "2025-01-16T17:01:07.217803",
        repoUrl:
          "https://github.com/squads-protocol/squads-mpl/tree/c95b7673d616c377a349ca424261872dfcf8b19d",
        source: "osec",
        verifiedHash: "72da599d9ee14b2a03a23ccfa6f06d53eea4a00825ad2191929cbd78fb69205c",
      },
    });
    // The API's verified hash equals the hash Vigil computed from the deployed code.
    expect(byAddress(result.programs, J24J)?.verification).toBe("verified");
    expect(byAddress(result.programs, J24J)?.verificationDetails?.hashMismatch).toBeUndefined();
    expect(byAddress(result.programs, SETT1ERE)).toMatchObject({
      verification: "unverified",
      verificationDetails: { source: "osec" },
    });
    expect(byAddress(result.programs, SETT1ERE)?.verificationDetails).toEqual({ source: "osec" });
    expect(byAddress(result.programs, CPMM)).toMatchObject({
      verification: "unverified",
      verificationDetails: {
        commit: "cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce",
        repoUrl:
          "https://github.com/raydium-io/raydium-cp-swap/tree/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce",
      },
    });
    // Native programs are part of the validator: never asked.
    expect(byAddress(result.programs, SYSTEM)?.verification).toBe("unknown");
    expect(http.calls.map((c) => c.url).sort()).toEqual(
      [CPMM, J24J, SETT1ERE, SQUADS_V3].map((p) => `https://verify.osec.io/status/${p}`).sort(),
    );
    expect(http.calls.every((c) => c.options.timeoutMs === VERIFICATION_TIMEOUT_MS)).toBe(true);
    expect(VERIFICATION_TIMEOUT_MS).toBe(8_000);
  });

  it("reports a verified answer whose build hash differs from the deployed code as unverified", async () => {
    // The real answer for J24jWEos... applied to a program whose deployed code hashes differently
    // (Sett1ere's real hash): what Vigil would see if J24jWEos... were upgraded after verification.
    const http = await loadRecordedHttp("http/verification-osec");
    const j24j = byAddress(facts, J24J);
    const sett1ere = byAddress(facts, SETT1ERE);
    if (j24j === undefined || sett1ere?.executableHash === undefined) {
      throw new Error("fixture incomplete");
    }
    const upgraded: ProgramInfo = { ...j24j, executableHash: sett1ere.executableHash };
    const result = await addVerification([upgraded], {
      cache: new VerificationCache(clock()),
      enabled: true,
      http,
    });
    expect(result.programs[0]).toMatchObject({
      verification: "unverified",
      verificationDetails: {
        hashMismatch: true,
        verifiedHash: "a83b811dd1659a91d5861ad8e329417caca09e2dc6bd7e0916d8a4655387dcf5",
      },
    });
  });

  it("drops a commit that is not a hex commit (Marinade's real answer has an empty one)", async () => {
    const http = await loadRecordedHttp("http/verification-osec");
    const marinade = address("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
    const result = await addVerification(
      [
        {
          address: marinade,
          loader: "upgradeable",
          upgrade: { kind: "unknown" },
          verification: "unknown",
        },
      ],
      { cache: new VerificationCache(clock()), enabled: true, http },
    );
    expect(result.programs[0]).toEqual({
      address: marinade,
      loader: "upgradeable",
      upgrade: { kind: "unknown" },
      verification: "unverified",
      verificationDetails: {
        lastVerifiedAt: "2024-01-26T07:53:47.286115",
        repoUrl: "https://github.com/marinade-finance/liquid-staking-program",
        source: "osec",
        verifiedHash: "daeb88a604e11a83382fd2e318abb99e455fd02a2b612227e61e0bb7b5568ab7",
      },
    });
  });
});

describe("API failures end in a gap, never an exception", () => {
  const cases: [string, () => Promise<{ status: number; text: string }>, string][] = [
    [
      "timeout",
      () =>
        Promise.reject(new HttpError("TIMEOUT", "no answer from verify.osec.io within 8000 ms")),
      "no answer from verify.osec.io within 8000 ms",
    ],
    [
      "network",
      () =>
        Promise.reject(new HttpError("NETWORK", "could not reach verify.osec.io: fetch failed")),
      "could not reach verify.osec.io: fetch failed",
    ],
    [
      "HTTP 503",
      () => Promise.resolve({ status: 503, text: "<html>Service Unavailable</html>" }),
      "the API answered HTTP 503",
    ],
    ["not JSON", () => Promise.resolve({ status: 200, text: "<html>" }), "the answer is not JSON"],
    [
      "wrong shape",
      () => Promise.resolve({ status: 200, text: '{"verified":true}' }),
      "the answer has no boolean `is_verified`",
    ],
    [
      "bad hash",
      () => Promise.resolve({ status: 200, text: '{"is_verified":true,"executable_hash":"zz"}' }),
      "`executable_hash` is not a SHA-256 hex hash",
    ],
    ["unexpected error", () => Promise.reject(new TypeError("boom")), "unexpected error"],
  ];
  for (const [name, fail, reason] of cases) {
    it(`${name}: unknown status and a PROGRAM_VERIFICATION_UNKNOWN gap`, async () => {
      const http = failingHttp(fail);
      const result = await addVerification(facts, {
        cache: new VerificationCache(clock()),
        enabled: true,
        http,
      });
      const asked = [CPMM, J24J, SQUADS_V3, SETT1ERE];
      expect(http.calls).toBe(asked.length);
      expect(result.programs.map((p) => p.verification)).toEqual(facts.map(() => "unknown"));
      expect(result.gaps.map((g) => [g.code, g.address])).toEqual(
        asked.map((a) => ["PROGRAM_VERIFICATION_UNKNOWN", a]),
      );
      expect(result.gaps[0]?.message).toBe(
        `verify.osec.io could not say whether this program is verified: ${reason}`,
      );
    });
  }
});

describe("cache and opt-out", () => {
  it("caches answers for one hour of the injected clock, and never caches failures", async () => {
    const recorded = await loadRecordedHttp("http/verification-osec");
    const time = clock();
    const cache = new VerificationCache(time);
    const cpmm = facts.filter((p) => p.address === CPMM);
    await addVerification(cpmm, { cache, enabled: true, http: recorded });
    await addVerification(cpmm, { cache, enabled: true, http: recorded });
    expect(recorded.calls).toHaveLength(1);
    time.advance(VERIFICATION_CACHE_TTL_MS - 1);
    await addVerification(cpmm, { cache, enabled: true, http: recorded });
    expect(recorded.calls).toHaveLength(1);
    time.advance(1);
    await addVerification(cpmm, { cache, enabled: true, http: recorded });
    expect(recorded.calls).toHaveLength(2);

    const failing = failingHttp(() => Promise.resolve({ status: 500, text: "" }));
    const cold = new VerificationCache(time);
    await addVerification(cpmm, { cache: cold, enabled: true, http: failing });
    await addVerification(cpmm, { cache: cold, enabled: true, http: failing });
    expect(failing.calls).toBe(2);
  });

  it("does not contact the API when turned off, and says so once", async () => {
    const http = failingHttp(() => Promise.reject(new Error("must not be called")));
    const result = await addVerification(facts, {
      cache: new VerificationCache(clock()),
      enabled: false,
      http,
    });
    expect(http.calls).toBe(0);
    expect(result.programs).toEqual(facts);
    expect(result.gaps.map((g) => g.code)).toEqual(["PROGRAM_VERIFICATION_DISABLED"]);
    const nativeOnly = await addVerification(
      facts.filter((p) => p.address === SYSTEM),
      {
        cache: new VerificationCache(clock()),
        enabled: false,
        http,
      },
    );
    expect(nativeOnly.gaps).toEqual([]);
  });
});

describe("links from the API", () => {
  it("keeps only plain https://github.com/<owner>/<repo> URLs", () => {
    expect(githubUrl("https://github.com/Squads-Protocol/v4/tree/3742e55")).toBe(
      "https://github.com/Squads-Protocol/v4/tree/3742e55",
    );
    for (const bad of [
      "javascript:alert(1)",
      "http://github.com/a/b",
      "https://github.com.evil.example/a/b",
      "https://evil.example/github.com/a/b",
      "https://user@github.com/a/b",
      "https://github.com:8443/a/b",
      "https://github.com/a/b?x=1",
      "https://github.com/a/b#frag",
      "https://github.com/a",
      "https://github.com/a/b/%2e%2e/c",
      "",
      42,
      null,
      `https://github.com/a/${"b".repeat(400)}`,
    ]) {
      expect(githubUrl(bad), String(bad)).toBeUndefined();
    }
  });

  it("parses the real answers and rejects other shapes", () => {
    expect(parseVerificationStatus('{"is_verified":false,"commit":"None","repo_url":""}')).toEqual({
      isVerified: false,
    });
    expect(() => parseVerificationStatus("[]")).toThrow("not a JSON object");
    expect(
      parseVerificationStatus('{"is_verified":true,"last_verified_at":"yesterday"}').lastVerifiedAt,
    ).toBeUndefined();
  });
});
