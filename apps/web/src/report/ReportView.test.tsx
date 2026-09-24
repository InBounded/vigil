/**
 * The report screen on real reports of each verdict (captured mainnet data, analysed with the
 * same calls the app makes; see test-support/fixtures.ts).
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { type AnalysisReport, serializeReport } from "@vigil-sol/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fixtureEnvironment, fixtureReport } from "../test-support/fixtures.js";
import { renderWith } from "../test-support/render.js";
import { ReportView } from "./ReportView.js";

type VerdictFixture = "upgrade-proposal" | "opaque-proposal" | "raw-usdc-transfer" | "hostile-memo";

const reports = new Map<VerdictFixture, AnalysisReport>();

beforeAll(async () => {
  for (const name of [
    "upgrade-proposal",
    "opaque-proposal",
    "raw-usdc-transfer",
    "hostile-memo",
  ] as const) {
    reports.set(name, await fixtureReport(name));
  }
}, 60_000);

function report(name: VerdictFixture): AnalysisReport {
  const value = reports.get(name);
  if (value === undefined) {
    throw new Error(`no report for ${name}`);
  }
  return value;
}

async function show(name: VerdictFixture, onReanalyze = () => undefined) {
  const env = await fixtureEnvironment(name);
  const view = renderWith(
    <ReportView report={report(name)} onReanalyze={onReanalyze} />,
    env.environment,
  );
  return { ...env, view };
}

/** Top-level section headings, in page order. */
function headings(): string[] {
  return screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
}

describe("ReportView, one real report per verdict", () => {
  it.each([
    ["upgrade-proposal", "critical", "✖", "Critical findings"],
    ["opaque-proposal", "incomplete", "?", "Analysis incomplete"],
    ["raw-usdc-transfer", "attention", "⚠", "Needs attention"],
    ["hostile-memo", "no-findings", "○", "No findings from the checks performed"],
  ] as const)(
    "%s: verdict %s as symbol, words and colour class",
    async (name, verdict, symbol, words) => {
      expect(report(name).verdict).toBe(verdict);
      await show(name);
      const banner = screen.getByRole("region", { name: new RegExp(words) });
      expect(banner.className).toContain(`verdict-${verdict}`);
      expect(within(banner).getByText(symbol)).toBeTruthy();
      expect(within(banner).getByRole("heading").textContent).toContain(words);
      // Slot and time of the analysis, and the Re-analyze button, are in the banner.
      expect(banner.textContent).toContain(`slot ${report(name).contextSlot}`);
      expect(within(banner).getByRole("button", { name: "Re-analyze" })).toBeTruthy();
    },
  );

  it("never calls anything safe, and has no check mark", async () => {
    for (const name of reports.keys()) {
      const { view } = await show(name);
      expect(view.container.textContent).not.toMatch(/\bsafe\b|\bsecure\b|✓|✔/i);
      view.unmount();
    }
  });

  it("shows the sections in the required order, the re-analyze notice right after the verdict", async () => {
    const { view } = await show("raw-usdc-transfer");
    expect(headings()).toEqual([
      expect.stringContaining("Needs attention"),
      "Findings (4)",
      "What this transaction does",
      "Balance changes if executed now",
      expect.stringMatching(/^Programs involved/),
      "Technical details",
    ]);
    const banner = view.container.querySelector(".verdict");
    expect(banner?.nextElementSibling?.textContent).toContain("Re-analyze right before you vote.");
  });

  it("lists critical findings first, each with its evidence and why it matters", async () => {
    await show("upgrade-proposal");
    const items = screen.getAllByRole("listitem").filter((li) => li.classList.contains("finding"));
    const severities = items.map((li) => li.className.replace(/.*finding-/, ""));
    expect(severities[0]).toBe("critical");
    expect(severities.indexOf("critical")).toBeLessThan(severities.indexOf("warning"));
    expect(severities.lastIndexOf("warning")).toBeLessThan(severities.indexOf("info"));
    const first = items[0];
    if (first === undefined) {
      throw new Error("no finding");
    }
    expect(within(first).getByText("VGL-C001")).toBeTruthy();
    expect(within(first).getByText("Critical")).toBeTruthy();
    expect(first.textContent).toContain("Why it matters");
    expect(within(first).getByText("Evidence")).toBeTruthy();
  });

  it("marks the analysis incomplete with every gap listed", async () => {
    await show("opaque-proposal");
    const gaps = screen.getByRole("region", { name: /Not checked/ });
    expect(gaps.textContent).toContain("The absence of findings says nothing about them.");
    expect(within(gaps).getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("numbers what the transaction does and shows every address in full with a copy button", async () => {
    await show("raw-usdc-transfer");
    const does = screen.getByRole("region", { name: "What this transaction does" });
    const steps = within(does).getAllByRole("listitem");
    expect(steps.length).toBe(report("raw-usdc-transfer").instructions.length);
    const addresses = does.querySelectorAll(".address-value");
    expect(addresses.length).toBeGreaterThan(0);
    for (const code of addresses) {
      // Full base58 address, split into groups of four for comparison.
      expect(code.textContent).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(code.querySelectorAll(".address-group").length).toBeGreaterThanOrEqual(8);
    }
    expect(within(does).getAllByRole("button", { name: "Copy address" }).length).toBe(
      addresses.length,
    );
  });

  it("puts the snapshot note before any balance change", async () => {
    // The one verdict fixture whose simulation succeeded with balance changes.
    await show("opaque-proposal");
    const balances = screen.getByRole("region", { name: "Balance changes if executed now" });
    const note = within(balances).getByRole("note");
    expect(note.textContent).toMatch(/Snapshot, not a guarantee/i);
    const firstAmount = balances.querySelector(".amount");
    expect(firstAmount).not.toBeNull();
    expect(
      note.compareDocumentPosition(firstAmount as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows each program's upgradeability, verification and explorer links", async () => {
    await show("upgrade-proposal");
    const programs = screen.getByRole("region", { name: /Programs involved/ });
    expect(programs.textContent).toMatch(/Verification: /);
    const links = within(programs).getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link.getAttribute("href")).toMatch(
        /^https:\/\/(explorer\.solana\.com\/address|solscan\.io\/account)\//,
      );
    }
  });

  it("keeps technical details collapsed by default", async () => {
    const { view } = await show("raw-usdc-transfer");
    const details = view.container.querySelector("details.technical");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.textContent).toContain("Raw instruction data (hex)");
  });

  it("copies the report as JSON (the serializer's exact output) and as text", async () => {
    const { clipboard } = await show("raw-usdc-transfer");
    fireEvent.click(screen.getByRole("button", { name: "Copy report as JSON" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy report as text" }));
    await vi.waitFor(() => expect(clipboard.length).toBe(2));
    expect(clipboard[0]).toBe(serializeReport(report("raw-usdc-transfer")));
    const text = clipboard[1] ?? "";
    expect(text).toContain("⚠ NEEDS ATTENTION");
    expect(text).toContain("Re-analyze right before you vote.");
    expect(text).toContain("SNAPSHOT, NOT A GUARANTEE");
    expect(text).toContain("nothing was signed or sent");
    // Full addresses, never shortened.
    expect(text).not.toContain("…");
    const feePayer = report("raw-usdc-transfer").rawTransaction?.feePayer ?? "";
    expect(text).toContain(feePayer);
  });

  it("re-analyzes on request", async () => {
    const onReanalyze = vi.fn();
    await show("hostile-memo", onReanalyze);
    fireEvent.click(screen.getByRole("button", { name: "Re-analyze" }));
    expect(onReanalyze).toHaveBeenCalledOnce();
  });

  it("says so when the RPC's network differs from the one asked for", async () => {
    const env = await fixtureEnvironment("hostile-memo");
    renderWith(
      <ReportView
        report={report("hostile-memo")}
        onReanalyze={() => undefined}
        requestedCluster="devnet"
      />,
      env.environment,
    );
    expect(
      screen.getByText(/You asked for Devnet, but the RPC endpoint is on Mainnet/),
    ).toBeTruthy();
  });

  it("shows the RPC host only, never a full endpoint URL", async () => {
    const { view } = await show("upgrade-proposal");
    expect(view.container.textContent).toContain("rpc.example.test");
    expect(view.container.textContent).not.toContain("https://rpc.example.test");
  });
});
