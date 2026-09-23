import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { CATALOGS, formatDuration, LOCALES, renderFinding } from "../i18n/render.js";
import type { Finding } from "../report.js";
import { getVaultPda } from "../squads/pda.js";
import { account, addr, context, instruction, multisig } from "../test-support/rules.js";
import { CONFUSABLES_VERSION } from "./confusables.generated.js";
import { renderRulesMarkdown } from "./docs.js";
import { ALWAYS_FIRST_RULE, computeVerdict, RULES, runRules } from "./engine.js";
import { describeAddress, finding, isInstruction, PROGRAMS } from "./helpers.js";
import {
  DEFAULT_RULE_OPTIONS,
  MAX_HISTORY_DEPTH,
  RuleOptionsError,
  resolveRuleOptions,
} from "./options.js";
import { lookAlikeForms, looksAlike } from "./skeleton.js";
import type { Rule } from "./types.js";
import { onlyProposes, walkInstructions } from "./walk.js";

const A = addr(1);
const B = addr(2);

const PLACEHOLDER = /\{([A-Za-z0-9_.]+)(?::[A-Za-z]+)?\}/g;

describe("rule catalogue", () => {
  it("has unique ids in order, with the severity their id says", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(28);
    for (const rule of RULES) {
      const letter = rule.id.charAt(4);
      expect(rule.defaultSeverity, rule.id).toBe(
        letter === "C" ? "critical" : letter === "W" ? "warning" : "info",
      );
      expect(rule.titleKey).toBe(`finding.${rule.id}`);
      for (const text of [rule.name, rule.docs.what, rule.docs.why, rule.docs.falsePositives]) {
        expect(text.length, rule.id).toBeGreaterThan(0);
      }
    }
  });

  it("has a sentence for every finding variant in both languages, with the same placeholders", () => {
    const keys = RULES.flatMap((rule) =>
      rule.variants.map((v) => (v === "" ? rule.titleKey : `${rule.titleKey}.${v}`)),
    );
    for (const key of [...keys, "finding.proposed"]) {
      for (const locale of LOCALES) {
        expect(CATALOGS[locale][key], `${locale} ${key}`).toBeDefined();
      }
      const placeholders = (locale: (typeof LOCALES)[number]) =>
        [...(CATALOGS[locale][key] ?? "").matchAll(PLACEHOLDER)].map((m) => m[0]).sort();
      expect(placeholders("pt-PT"), key).toEqual(placeholders("en"));
    }
    // No finding text left without a rule.
    const findingKeys = Object.keys(CATALOGS.en).filter((k) => k.startsWith("finding."));
    const expected = new Set([...keys, "finding.proposed"]);
    for (const key of findingKeys) {
      expect(expected.has(key.replace(/\.without\.[A-Za-z]+$/, "")), key).toBe(true);
    }
  });

  it("docs/rules.md is exactly what `pnpm docs:rules` generates", async () => {
    const committed = await readFile(
      fileURLToPath(new URL("../../../../docs/rules.md", import.meta.url)),
      "utf8",
    );
    expect(committed).toBe(renderRulesMarkdown(RULES));
    for (const rule of RULES) {
      expect(committed).toContain(`### ${rule.id} — ${rule.name}`);
    }
  });

  it("builds the confusables table from Unicode 18.0.0", () => {
    expect(CONFUSABLES_VERSION).toBe("18.0.0");
  });
});

function made(ruleId: string, severity: Finding["severity"], instructionIndex?: number): Finding {
  return {
    evidence: [],
    params: {},
    provenance: "rule-inference",
    ruleId,
    severity,
    titleKey: `finding.${ruleId}`,
    ...(instructionIndex === undefined ? {} : { instructionIndex }),
  };
}

function fixed(findings: Finding[]): Rule {
  return {
    defaultSeverity: "info",
    docs: { falsePositives: "-", what: "-", why: "-" },
    evaluate: () => findings,
    id: "TEST",
    name: "test",
    titleKey: "finding.TEST",
    variants: [""],
  };
}

describe("engine", () => {
  it("orders findings: incomplete analysis first, then severity, instruction, rule id, rule order", async () => {
    const ctx = await context();
    const findings = runRules(ctx, [
      fixed([
        made("VGL-I002", "info", 0),
        made("VGL-C003", "critical", 2),
        made("VGL-W004", "warning"),
        made("VGL-C001", "critical", 2),
        made("VGL-C001", "critical", 1),
        { ...made("VGL-C001", "critical", 2), params: { order: "second" } },
        made(ALWAYS_FIRST_RULE, "warning"),
      ]),
    ]);
    expect(findings.map((f) => [f.ruleId, f.instructionIndex, f.params.order])).toEqual([
      ["VGL-W011", undefined, undefined],
      ["VGL-C001", 1, undefined],
      ["VGL-C001", 2, undefined],
      ["VGL-C001", 2, "second"],
      ["VGL-C003", 2, undefined],
      ["VGL-W004", undefined, undefined],
      ["VGL-I002", 0, undefined],
    ]);
  });

  it("runs every rule by default", async () => {
    const ctx = await context({ gaps: [{ code: "UNKNOWN_PROGRAM", message: "x" }] });
    expect(runRules(ctx).map((f) => f.ruleId)).toEqual(["VGL-W011"]);
  });

  it("computes the verdict: critical, else incomplete, else attention, else no findings", () => {
    const gap = [{ code: "UNKNOWN_PROGRAM" as const, message: "x" }];
    expect(computeVerdict([made("VGL-C001", "critical")], gap)).toBe("critical");
    expect(computeVerdict([made("VGL-W004", "warning")], gap)).toBe("incomplete");
    expect(computeVerdict([made("VGL-W004", "warning"), made("VGL-I001", "info")], [])).toBe(
      "attention",
    );
    expect(computeVerdict([made("VGL-I001", "info")], [])).toBe("no-findings");
    expect(computeVerdict([], [])).toBe("no-findings");
  });
});

describe("options", () => {
  it("defaults to 10 % and no history, known addresses or absolute thresholds", () => {
    expect(DEFAULT_RULE_OPTIONS).toEqual({ historyDepth: 0, largeTransferPercent: 10 });
    const resolved = resolveRuleOptions();
    expect(resolved.largeTransferBasisPoints).toBe(1000n);
    expect(resolved.historyDepth).toBe(0);
    expect(resolved.knownAddresses.size).toBe(0);
    expect(resolved.largeTransferAbsolute.size).toBe(0);
    expect(resolveRuleOptions({ largeTransferPercent: 0.01 }).largeTransferBasisPoints).toBe(1n);
    expect(
      resolveRuleOptions({ largeTransferPercent: 100, historyDepth: MAX_HISTORY_DEPTH })
        .largeTransferBasisPoints,
    ).toBe(10_000n);
  });

  it("rejects invalid values with a typed error", () => {
    for (const options of [
      { largeTransferPercent: 0 },
      { largeTransferPercent: 100.01 },
      { largeTransferPercent: 1.234 },
      { largeTransferPercent: Number.NaN },
      { largeTransferPercent: Number.POSITIVE_INFINITY },
      { historyDepth: -1 },
      { historyDepth: 1.5 },
      { historyDepth: MAX_HISTORY_DEPTH + 1 },
      { largeTransferAbsolute: new Map([["SOL" as const, 0n]]) },
    ]) {
      expect(() => resolveRuleOptions(options), JSON.stringify(options)).toThrow(RuleOptionsError);
    }
    try {
      resolveRuleOptions({ historyDepth: -1 });
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_RULE_OPTIONS", name: "RuleOptionsError" });
    }
  });
});

describe("rule context", () => {
  it("derives vaults 0\u201315 plus the proposal's own index, and records why each address is known", async () => {
    const ms = multisig({
      members: [
        { key: A, permissions: ["Vote"] },
        { key: A, permissions: ["Vote"] },
      ],
    });
    const [vault40] = await getVaultPda({ index: 40, multisigPda: ms.address });
    const [vault0] = await getVaultPda({ index: 0, multisigPda: ms.address });
    const ctx = await context({
      facts: { recentDestinations: new Set([B, vault0]) },
      multisig: ms,
      options: { knownAddresses: new Map([[A, "Me"]]) },
      vaultIndex: 40,
    });
    expect(ctx.vaults.size).toBe(17);
    expect(ctx.vaults.get(vault40)).toBe(40);
    expect(ctx.known.get(A)).toEqual(["member", "user"]);
    expect(ctx.known.get(ms.address)).toEqual(["multisig"]);
    expect(ctx.known.get(vault0)).toEqual(["vault", "recent-destination"]);
    expect(ctx.known.get(B)).toEqual(["recent-destination"]);
    expect(ctx.known.get(PROGRAMS.token)).toEqual(["registry-program"]);
    expect(ctx.known.get(address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"))).toEqual([
      "registry-token",
    ]);
    expect(describeAddress(ctx, vault40)).toBe("vault #40");
    expect(describeAddress(ctx, A)).toBe('user label "Me"');
    expect(describeAddress(ctx, B)).toBe("recent-destination");
    expect(describeAddress(ctx, addr(99))).toBe("unknown");
  });

  it("knows registry tokens only on their own cluster, and no vaults without a multisig", async () => {
    const devnet = await context({ cluster: "devnet" });
    expect(devnet.known.has(address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"))).toBe(false);
    expect(devnet.vaults.size).toBe(0);
    expect(devnet.facts).toEqual({});
  });
});

describe("walking instructions", () => {
  const squadsCreate = (
    transaction: string | undefined,
    inner = [instruction({ programId: PROGRAMS.system })],
  ) =>
    instruction({
      accounts: transaction === undefined ? [] : [account(transaction as never, "transaction")],
      decoder: "squads",
      inner,
      name: "vaultTransactionCreate",
      programId: PROGRAMS.squads,
    });
  const execute = (transaction: string) =>
    instruction({
      accounts: [account(transaction as never, "transaction")],
      decoder: "squads",
      name: "vaultTransactionExecute",
      programId: PROGRAMS.squads,
    });

  it("gives every instruction its path, depth and top-level index", () => {
    const walked = walkInstructions([
      instruction({ programId: PROGRAMS.system }),
      instruction({
        inner: [
          instruction({
            inner: [instruction({ programId: PROGRAMS.token })],
            programId: PROGRAMS.token,
          }),
        ],
        programId: PROGRAMS.token,
      }),
    ]);
    expect(walked.map((w) => [w.path, w.depth, w.topIndex, w.proposed])).toEqual([
      ["0", 0, 0, false],
      ["1", 0, 1, false],
      ["1.0", 1, 1, false],
      ["1.0.0", 2, 1, false],
    ]);
  });

  it("marks a Squads message as proposed unless the same transaction executes it", () => {
    expect(walkInstructions([squadsCreate(A)])[1]?.proposed).toBe(true);
    expect(walkInstructions([squadsCreate(A), execute(A)])[1]?.proposed).toBe(false);
    expect(walkInstructions([squadsCreate(A), execute(B)])[1]?.proposed).toBe(true);
    expect(walkInstructions([squadsCreate(undefined)])[1]?.proposed).toBe(true);
    // An execute instruction that could not be decoded, or has no name, proves nothing.
    expect(
      walkInstructions([
        squadsCreate(A),
        { ...execute(A), decoder: "none" },
        { ...execute(A), name: undefined } as never,
        instruction({
          decoder: "squads",
          name: "vaultTransactionExecute",
          programId: PROGRAMS.squads,
        }),
      ])[1]?.proposed,
    ).toBe(true);
    expect(onlyProposes(instruction({ programId: PROGRAMS.token }), new Set())).toBe(false);
  });
});

describe("helpers", () => {
  it("builds findings with the right key, index and proposed marker", async () => {
    const rule = fixed([]);
    expect(finding(rule, { evidence: [], provenance: "onchain" })).toEqual({
      evidence: [],
      params: {},
      provenance: "onchain",
      ruleId: "TEST",
      severity: "info",
      titleKey: "finding.TEST",
    });
    expect(
      finding(rule, { evidence: [], instructionIndex: 3, provenance: "onchain", variant: "" }),
    ).toMatchObject({
      instructionIndex: 3,
      titleKey: "finding.TEST",
    });
    const [at] = walkInstructions([instruction({ programId: PROGRAMS.system })]);
    if (at === undefined) {
      throw new Error("nothing walked");
    }
    expect(
      finding(rule, { at, evidence: ["x: 1"], provenance: "onchain", variant: "v" }),
    ).toMatchObject({
      evidence: ["x: 1", "instruction: 0"],
      instructionIndex: 0,
      titleKey: "finding.TEST.v",
    });
  });

  it("matches only decoded, named instructions of the right program", () => {
    expect(
      isInstruction(
        instruction({ name: "assign", programId: PROGRAMS.system }),
        PROGRAMS.system,
        "assign",
      ),
    ).toBe(true);
    expect(
      isInstruction(instruction({ programId: PROGRAMS.system }), PROGRAMS.system, "assign"),
    ).toBe(false);
    expect(
      isInstruction(
        instruction({ name: "assign", programId: PROGRAMS.token }),
        PROGRAMS.system,
        "assign",
      ),
    ).toBe(false);
  });
});

describe("look-alike token names", () => {
  it("maps look-alike characters, width and case, keeping letters and digits", () => {
    expect([...lookAlikeForms("U\u0405D\u0421")]).toEqual(["usdc"]);
    expect([...lookAlikeForms("\uFF35\uFF33\uFF24\uFF23")]).toEqual(["usdc"]);
    expect([...lookAlikeForms("INF")]).toEqual(["lnf", "inf"]);
    expect([...lookAlikeForms("...")]).toEqual([]);
    expect(looksAlike("1NF", "INF")).toBe(true);
    expect(looksAlike("inf", "INF")).toBe(true);
    expect(looksAlike("BONK", "USDC")).toBe(false);
    expect(looksAlike("", "")).toBe(false);
  });
});

describe("rendering findings", () => {
  it("uses labels from the report's instructions, nested ones included", () => {
    const labelled = instruction({
      inner: [
        instruction({
          accounts: [
            {
              ...account(A),
              label: { key: "label.vault", params: { index: "2" }, source: "multisig" },
            },
          ],
          programId: PROGRAMS.system,
        }),
      ],
      programId: PROGRAMS.squads,
    });
    const text = renderFinding(
      { ...made("VGL-C005", "critical"), params: { account: A, owner: B } },
      "en",
      [labelled],
    ).text;
    expect(text).toContain("Changes the owner program of Vault #2 to");
  });

  it("reports a finding without a sentence as missing instead of inventing one", () => {
    expect(renderFinding(made("VGL-X999", "info"), "en")).toEqual({
      missing: ["finding.VGL-X999"],
      text: "finding.VGL-X999",
    });
  });

  it("formats durations and permissions", () => {
    expect(formatDuration(0n, "en")).toBe("0 s");
    expect(formatDuration(90_061n, "pt-PT")).toBe("1 d 1 h 1 min 1 s");
    expect(formatDuration(3_600n, "en")).toBe("1 h");
    const addMember = {
      ...made("VGL-C006", "critical"),
      params: { member: A, permissions: "Initiate,Vote,Execute" },
      titleKey: "finding.VGL-C006.addMember",
    };
    expect(renderFinding(addMember, "pt-PT").text).toContain(
      "com as permissões: iniciar, votar, executar",
    );
    expect(
      renderFinding({ ...addMember, params: { member: A, permissions: "Other" } }, "en").text,
    ).toContain("with permissions: Other");
    const timeLock = {
      ...made("VGL-C006", "critical"),
      params: { newTimeLock: "soon" },
      titleKey: "finding.VGL-C006.timeLock",
    };
    expect(renderFinding(timeLock, "en").text).toBe("Sets the time lock to soon");
  });

  it("shows unknown addresses and values as unknown", () => {
    const upgrade = {
      ...made("VGL-C001", "critical"),
      params: {
        buffer: "unknown",
        bufferHash: "unknown",
        program: "unknown",
        verification: "other",
      },
    };
    expect(renderFinding(upgrade, "pt-PT").text).toBe(
      "Atualiza o programa desconhecido com o código do buffer desconhecido (hash executável desconhecido; verificação atual do programa: other)",
    );
    // On-chain text is shown verbatim: a memo that says "none" is not translated.
    const memo = { ...made("VGL-I002", "info"), params: { memo: "none" } };
    expect(renderFinding(memo, "pt-PT").text).toBe("Memo: “none”");
  });
});
