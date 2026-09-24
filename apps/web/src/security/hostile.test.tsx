/**
 * Hostile strings render as harmless text. The fixture is an attacker-controlled pasted
 * transaction (fixtures/web/hostile-memo.base64, built by scripts/build-hostile-memo-transaction.ts)
 * analysed live on mainnet: its memo holds HTML, a script tag, a `javascript:` link, bidi
 * overrides, zero-width characters and a Unicode tag character.
 */
import { fireEvent, screen } from "@testing-library/react";
import type { AnalysisReport } from "@vigil-sol/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { safeText } from "../lib/safe-text.js";
import { ReportView } from "../report/ReportView.js";
import { reportToText } from "../report/text.js";
import { fixtureEnvironment, fixtureReport } from "../test-support/fixtures.js";
import { renderWith } from "../test-support/render.js";

/** Bidi controls, zero-width and invisible characters, Unicode tag characters (as code points). */
const INVISIBLE = [
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066,
  0x2067, 0x2068, 0x2069, 0xfeff, 0x061c, 0x2028, 0x2029, 0xe0041,
].map((code) => String.fromCodePoint(code));

function invisibleIn(text: string): string[] {
  return INVISIBLE.filter((char) => text.includes(char)).map(
    (char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
  );
}

/** Elements hostile text must never turn into. */
const DANGEROUS = "script, img, iframe, object, embed, svg, style, link, meta, form, base";

let report: AnalysisReport;

beforeAll(async () => {
  report = await fixtureReport("hostile-memo");
}, 60_000);

async function show(value: AnalysisReport) {
  const env = await fixtureEnvironment("hostile-memo");
  return {
    ...env,
    view: renderWith(<ReportView report={value} onReanalyze={() => undefined} />, env.environment),
  };
}

describe("hostile on-chain strings (real captured analysis)", () => {
  it("the fixture really carries the hostile memo, flagged by core's sanitizer", () => {
    const [memo] = report.instructions;
    expect(memo?.summary?.params.memo).toContain('<script>alert("vigil")</script>');
    expect(memo?.summary?.params.memo).toContain("<img src=x onerror=alert(1)>");
    expect(memo?.sanitizer?.[0]?.flags).toEqual([
      "bidi-removed",
      "zero-width-removed",
      "invisible-removed",
    ]);
  });

  it("renders HTML as literal text, never as elements", async () => {
    const { view } = await show(report);
    const text = view.container.textContent ?? "";
    expect(text).toContain('<script>alert("vigil")</script>');
    expect(text).toContain("<img src=x onerror=alert(1)>");
    expect(text).toContain("<a href=javascript:alert(1)>claim</a>");
    expect(view.container.querySelectorAll(DANGEROUS)).toHaveLength(0);
    for (const link of view.container.querySelectorAll("a")) {
      expect(link.getAttribute("href")).toMatch(/^https:\/\//);
    }
    // No attribute anywhere holds an event handler.
    for (const element of view.container.querySelectorAll("*")) {
      for (const attribute of element.getAttributeNames()) {
        expect(attribute.startsWith("on"), `${element.tagName} ${attribute}`).toBe(false);
      }
    }
  });

  it("shows no bidi, zero-width or tag character, and says characters were removed", async () => {
    const { view } = await show(report);
    expect(invisibleIn(view.container.textContent ?? "")).toEqual([]);
    expect(
      screen.getAllByText(/Hidden or control characters were removed from this text/).length,
    ).toBeGreaterThan(0);
  });

  it("the copied text has no invisible characters either", async () => {
    const { clipboard } = await show(report);
    fireEvent.click(screen.getByRole("button", { name: "Copy report as text" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy report as JSON" }));
    await vi.waitFor(() => expect(clipboard.length).toBe(2));
    expect(invisibleIn(clipboard[0] ?? "")).toEqual([]);
    expect(clipboard[0]).toContain('<script>alert("vigil")</script>');
    // The JSON is the report itself: core already removed the characters.
    expect(invisibleIn(clipboard[1] ?? "")).toEqual([]);
  });

  it("strips them even from text core passes through unchanged (second barrier)", async () => {
    // Simulation logs and evidence are shown as the RPC and rules produced them; a program can log
    // anything. Put the hostile characters back into those places of the real report.
    const hostile = `evil${INVISIBLE.join("")}<img src=x onerror=alert(2)>`;
    const simulation = report.simulation;
    if (simulation === undefined || simulation.status !== "success") {
      throw new Error("fixture simulation expected to succeed");
    }
    const tampered: AnalysisReport = {
      ...report,
      findings: report.findings.map((finding) => ({
        ...finding,
        evidence: [...finding.evidence, hostile],
      })),
      simulation: { ...simulation, logs: [...simulation.logs, hostile] },
    };
    const { view } = await show(tampered);
    for (const details of view.container.querySelectorAll("details")) {
      details.setAttribute("open", "");
    }
    const text = view.container.textContent ?? "";
    expect(text).toContain("evil<img src=x onerror=alert(2)>");
    expect(invisibleIn(text)).toEqual([]);
    expect(view.container.querySelectorAll(DANGEROUS)).toHaveLength(0);
    expect(invisibleIn(reportToText(tampered, "en"))).toEqual([]);
  });
});

describe("safeText", () => {
  it("removes controls, bidi, zero-width, separators and tag characters; keeps text and line breaks", () => {
    const input = `a${INVISIBLE.join("")}b${String.fromCharCode(0, 7, 0x1b, 0x7f, 0x85)}c\nd\te`;
    expect(safeText(input)).toBe("abc\nd\te");
  });

  it("keeps ordinary non-ASCII text", () => {
    expect(safeText("Café · 東京 · Ελλάδα · ✖ ⚠ ○")).toBe("Café · 東京 · Ελλάδα · ✖ ⚠ ○");
  });
});
