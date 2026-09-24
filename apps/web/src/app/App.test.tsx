/**
 * The whole app, from a link, on real captured mainnet data: routing, the "Add your RPC endpoint"
 * step, per-step progress, the report, the multisig page with progressive analysis and "Load
 * more", the start page, settings, and address-poisoning highlighting.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_DEVNET_MULTISIG } from "../screens/HomeScreen.js";
import { DEFAULT_SETTINGS } from "../settings/settings.js";
import {
  BATCH_MULTISIG,
  FIXTURE_SETTINGS,
  type FixtureName,
  fixtureEnvironment,
  fixtureReport,
  lookalikeOf,
  rawBase64,
  UPGRADE_MULTISIG,
} from "../test-support/fixtures.js";
import { Root } from "./Root.js";

const SLOW = { timeout: 30_000 };

async function open(hash: string, fixture: FixtureName, settings = FIXTURE_SETTINGS) {
  globalThis.location.hash = hash;
  const env = await fixtureEnvironment(fixture, settings);
  render(<Root environment={env.environment} />);
  return env;
}

afterEach(() => {
  globalThis.location.hash = "";
});

describe("a proposal link", () => {
  it("shows each analysis step, then the report, reading only the configured endpoint", async () => {
    const { endpoints } = await open(`#/ms/${UPGRADE_MULTISIG}/4`, "upgrade-proposal");
    const progress = await screen.findByRole("heading", { name: "Analysis in progress" });
    const steps = within(progress.closest("section") as HTMLElement).getAllByRole("listitem");
    expect(
      steps.map((step) =>
        step.textContent
          ?.replace(/ \(.*\)$/, "")
          .slice(1)
          .trim(),
      ),
    ).toEqual([
      "Connecting to the network",
      "Reading multisig",
      "Decoding",
      "Simulating",
      "Checking programs",
      "Running the checks",
    ]);
    // Each step says its state in words, not only with a symbol.
    expect(steps[0]?.textContent).toMatch(/\((in progress|done|waiting)\)/);
    const banner = await screen.findByRole("region", { name: /Critical findings/ }, SLOW);
    expect(banner).toBeTruthy();
    expect(new Set(endpoints)).toEqual(new Set(["https://rpc.example.test/"]));
  }, 60_000);

  it("on mainnet without an endpoint, asks for one without naming any provider", async () => {
    const { store, endpoints } = await open(
      `#/ms/${UPGRADE_MULTISIG}/4`,
      "upgrade-proposal",
      DEFAULT_SETTINGS,
    );
    const heading = await screen.findByRole("heading", { name: "Add your RPC endpoint" });
    const panel = heading.closest("section") as HTMLElement;
    expect(panel.textContent).toContain(
      "The public mainnet endpoint refuses requests from web pages",
    );
    expect(within(panel).queryAllByRole("link")).toHaveLength(0);
    expect(endpoints).toEqual([]);
    const field = within(panel).getByLabelText("Mainnet RPC endpoint (https://…)");
    expect(field.getAttribute("type")).toBe("password");
    fireEvent.change(field, { target: { value: "http://insecure.example.test" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save and continue" }));
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(within(panel).getByText(/Enter an https:\/\/ address/)).toBeTruthy();
    fireEvent.change(field, { target: { value: "https://mine.example.test/?api-key=k" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save and continue" }));
    await screen.findByRole("region", { name: /Critical findings/ }, SLOW);
    expect(store.saved.at(-1)?.rpc.mainnet).toBe("https://mine.example.test/?api-key=k");
    expect(new Set(endpoints)).toEqual(new Set(["https://mine.example.test/?api-key=k"]));
    // Only the host is shown, never the key.
    expect(document.body.textContent).toContain("mine.example.test");
    expect(document.body.textContent).not.toContain("api-key");
  }, 60_000);

  it("says plainly when the address is not a multisig, and can retry", async () => {
    // An address the mainnet recording has no account for: the RPC says it does not exist.
    await open(`#/ms/${EXAMPLE_DEVNET_MULTISIG}/1`, "upgrade-proposal");
    const alert = await screen.findByRole("alert", undefined, SLOW);
    expect(alert.textContent).toContain("Analysis not possible");
    expect(alert.textContent).toContain(
      "This address is not a Squads v4 multisig on this network.",
    );
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alert", undefined, SLOW)).toBeTruthy();
  }, 60_000);

  it("refuses a malformed link", async () => {
    await open(`#/ms/${UPGRADE_MULTISIG}/0`, "upgrade-proposal");
    expect(await screen.findByRole("heading", { name: "This page does not exist." })).toBeTruthy();
  });
});

describe("the multisig page", () => {
  it("summarises the multisig and analyses the pending proposals one by one", async () => {
    await open(`#/ms/${BATCH_MULTISIG}`, "multisig-list");
    await screen.findByRole("heading", { name: "Multisig" }, SLOW);
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary.textContent).toMatch(/\d+ of \d+ members must approve/);
    // The fragility check is core's VGL-W010 rule.
    expect(within(summary).getByText("VGL-W010")).toBeTruthy();
    expect(within(summary).getAllByRole("row").length).toBeGreaterThan(1);

    const proposals = screen.getByRole("region", { name: "Recent proposals" });
    const rows = () => proposals.querySelectorAll(".proposal-row");
    expect(rows()).toHaveLength(20);
    // #2268 and #2267 are the pending drafts among the last 20; the others are not analysed.
    await waitFor(
      () => expect(within(proposals).getAllByText("Needs attention")).toHaveLength(2),
      SLOW,
    );
    expect(within(proposals).getAllByText("Not pending")).toHaveLength(18);
    const link = within(proposals).getByRole("link", { name: "Proposal #2268" });
    expect(link.getAttribute("href")).toBe(`#/ms/${BATCH_MULTISIG}/2268`);

    fireEvent.click(within(proposals).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(rows()).toHaveLength(40), SLOW);
    // #2255 is pending further down; the two reports already made are kept.
    await waitFor(
      () => expect(within(proposals).getAllByText("Needs attention")).toHaveLength(3),
      SLOW,
    );
    fireEvent.click(within(proposals).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(rows()).toHaveLength(50), SLOW);
    // 50 is the maximum.
    expect(within(proposals).queryByRole("button", { name: "Load more" })).toBeNull();
  }, 120_000);
});

describe("the start page", () => {
  it("detects a multisig address and a base64 transaction", async () => {
    await open("#/", "upgrade-proposal");
    const field = screen.getByLabelText("Multisig address or base64 transaction");
    fireEvent.change(field, { target: { value: ` ${UPGRADE_MULTISIG} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(globalThis.location.hash).toBe(`#/ms/${UPGRADE_MULTISIG}`);

    globalThis.location.hash = "#/";
    const again = await screen.findByLabelText("Multisig address or base64 transaction");
    fireEvent.change(again, { target: { value: rawBase64("raw-usdc-transfer") } });
    fireEvent.change(screen.getByLabelText("Network"), { target: { value: "devnet" } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(globalThis.location.hash.startsWith("#/tx?data=")).toBe(true);
    expect(globalThis.location.hash.endsWith("&cluster=devnet")).toBe(true);
  });

  it("explains invalid input next to the field", async () => {
    await open("#/", "upgrade-proposal");
    const field = screen.getByLabelText("Multisig address or base64 transaction");
    fireEvent.change(field, { target: { value: "not a thing" } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const error = screen.getByText("This is neither a valid address nor a base64 transaction.");
    expect(field.getAttribute("aria-describedby")).toContain(error.id);
    expect(globalThis.location.hash).toBe("#/");
  });

  it("fills in the devnet example", async () => {
    await open("#/", "upgrade-proposal");
    fireEvent.click(screen.getByRole("button", { name: "Example (devnet)" }));
    expect(
      (screen.getByLabelText("Multisig address or base64 transaction") as HTMLTextAreaElement)
        .value,
    ).toBe(EXAMPLE_DEVNET_MULTISIG);
    expect((screen.getByLabelText("Network") as HTMLSelectElement).value).toBe("devnet");
  });

  it("says what the tool does and does not do", async () => {
    await open("#/", "upgrade-proposal");
    expect(document.body.textContent).toContain("never asks for keys, never connects a wallet");
    expect(document.body.textContent).toContain("It never calls a proposal “safe”");
  });
});

describe("address poisoning", () => {
  it("highlights the look-alike of a known address, with the differing characters marked", async () => {
    // Real transaction; the user "knows" an address that shares the first and last four
    // characters with its real destination, as an attacker's ground address would.
    const report = await fixtureReport("raw-usdc-transfer");
    const destination = report.instructions
      .flatMap((ix) => ix.accounts)
      .find((account) => account.role === "destination")?.address;
    if (destination === undefined) {
      throw new Error("no destination in the fixture");
    }
    const known = lookalikeOf(destination);
    await open(
      `#/tx?data=${encodeURIComponent(rawBase64("raw-usdc-transfer"))}`,
      "raw-usdc-transfer",
      {
        ...FIXTURE_SETTINGS,
        knownAddresses: [{ address: known as never, label: "Our exchange account" }],
      },
    );
    const finding = (await screen.findByText("VGL-C008", undefined, SLOW)).closest(
      "li",
    ) as HTMLElement;
    expect(finding.className).toContain("finding-critical");
    const compared = finding.querySelectorAll(".poison-compare .address-value");
    expect([...compared].map((code) => code.textContent)).toEqual([destination, known]);
    for (const code of compared) {
      const marks = [...code.querySelectorAll("mark")].map((mark) => mark.textContent);
      expect(marks.length).toBeGreaterThan(0);
      expect(marks.length).toBeLessThan(4);
    }
    // Everywhere else the poisoned address appears, it is highlighted too.
    const does = screen.getByRole("region", { name: "What this transaction does" });
    const highlighted = does.querySelectorAll(".address-poisoned .address-value");
    expect([...highlighted].map((code) => code.textContent)).toContain(destination);
    expect(document.body.textContent).toContain(
      `Characters that differ from ${known} are highlighted.`,
    );
  }, 60_000);
});

describe("settings", () => {
  it("validates and saves", async () => {
    const { store } = await open("#/settings", "upgrade-proposal", DEFAULT_SETTINGS);
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.change(screen.getByLabelText("Mainnet RPC endpoint"), {
      target: { value: "https://rpc.example.test/key" },
    });
    fireEvent.change(screen.getByLabelText("Mainnet cross-check RPC endpoint (optional)"), {
      target: { value: "https://rpc.example.test/key" },
    });
    fireEvent.change(screen.getByLabelText("History depth"), { target: { value: "5000" } });
    fireEvent.change(screen.getByLabelText("USDC"), { target: { value: "1.1234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(
      screen.getByText("The cross-check endpoint must be different from the main one."),
    ).toBeTruthy();
    expect(screen.getByText("Enter a number from 0 to 1000.")).toBeTruthy();
    expect(screen.getByText(/at most 6 decimals/)).toBeTruthy();
    expect(store.saved).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Mainnet cross-check RPC endpoint (optional)"), {
      target: { value: "https://other.example.test/" },
    });
    fireEvent.change(screen.getByLabelText("History depth"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("USDC"), { target: { value: "250000" } });
    fireEvent.click(
      screen.getByLabelText(
        "Check programs' verified builds with the verification API (verify.osec.io)",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByText("Settings saved.")).toBeTruthy();
    expect(store.saved.at(-1)).toMatchObject({
      crossCheckRpc: { mainnet: "https://other.example.test/" },
      historyDepth: 100,
      largeTransferAbsolute: { USDC: "250000" },
      rpc: { mainnet: "https://rpc.example.test/key" },
      verification: false,
    });
  });

  it("adds and removes known addresses, and deletes all local data after confirmation", async () => {
    const { store } = await open("#/settings", "upgrade-proposal", DEFAULT_SETTINGS);
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: UPGRADE_MULTISIG } });
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "  Team multisig " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(store.saved.at(-1)?.knownAddresses).toEqual([
      { address: UPGRADE_MULTISIG, label: "Team multisig" },
    ]);
    expect(screen.getByText("Team multisig")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete all local data" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete everything" }));
    expect(await screen.findByText("All local data was deleted.")).toBeTruthy();
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
    expect(screen.getByText("No known addresses yet.")).toBeTruthy();
  });
});

describe("known-address files", () => {
  it("imports a vigil-labels file (sanitized) and exports the list", async () => {
    const { store } = await open("#/settings", "upgrade-proposal", DEFAULT_SETTINGS);
    await screen.findByRole("heading", { name: "Settings" });
    const file = new File(
      [
        JSON.stringify({
          format: "vigil-labels",
          labels: [
            { address: UPGRADE_MULTISIG, label: "Upgrade multisig" },
            { address: "notAnAddress", label: "skipped" },
          ],
          version: 1,
        }),
      ],
      "labels.json",
      { type: "application/json" },
    );
    fireEvent.change(screen.getByLabelText("Import JSON"), { target: { files: [file] } });
    expect(
      await screen.findByText(
        "Imported 1 address(es). 1 entries were skipped or changed; check the list.",
      ),
    ).toBeTruthy();
    expect(store.saved.at(-1)?.knownAddresses).toEqual([
      { address: UPGRADE_MULTISIG, label: "Upgrade multisig" },
    ]);

    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:vigil-test";
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:vigil-test");
    const exported = JSON.parse(await (created[0] as Blob).text()) as { labels: unknown };
    expect(exported.labels).toEqual([{ address: UPGRADE_MULTISIG, label: "Upgrade multisig" }]);
    click.mockRestore();
  });

  it("reports a file that is not a label file", async () => {
    await open("#/settings", "upgrade-proposal", DEFAULT_SETTINGS);
    await screen.findByRole("heading", { name: "Settings" });
    const file = new File(["{not json"], "labels.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Import JSON"), { target: { files: [file] } });
    expect(await screen.findByText("the label file is not valid JSON")).toBeTruthy();
  });
});

describe("layout and keyboard", () => {
  it("has a skip button, labelled navigation and marks the current page", async () => {
    await open("#/about", "upgrade-proposal");
    await screen.findByRole("heading", { name: "About Vigil and security" });
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(
      within(nav).getByRole("link", { name: "About & security" }).getAttribute("aria-current"),
    ).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Skip to content" }));
    expect(document.activeElement?.id).toBe("main");
  });

  it("the about page explains how to check the build", async () => {
    await open("#/about", "upgrade-proposal");
    await screen.findByRole("heading", { name: "About Vigil and security" });
    expect(document.body.textContent).toContain("sha256sum -c vigil-offline-<version>.html.sha256");
    expect(document.body.textContent).toContain("npx @vigil-sol/cli decode <multisig> <index>");
    expect(screen.getByRole("link", { name: "Release page (GitHub)" }).getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
  });
});
