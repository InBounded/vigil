import { fileURLToPath } from "node:url";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { loadFixtureFile } from "../rpc/fixture-file.js";
import { SquadsV4Adapter } from "./adapter.js";
import { NotASquadsMultisigError } from "./errors.js";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/${name}.json`, import.meta.url));
}

const MULTISIG_MIXED_PERMISSIONS = address("3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt");
const CONFIG_TRANSACTION_MULTISIG = address("4AUG3JkY43g39avoD5e66BVKCj5RDZRGQoKgGyNcDJnx");

describe("SquadsV4Adapter.fetchMultisig, against real captured data", () => {
  it("decodes the multisig-mixed-permissions fixture correctly", async () => {
    const data = await loadFixtureFile(fixturePath("multisig-mixed-permissions"));
    const adapter = new SquadsV4Adapter(new FixtureRpcClient(data));

    const summary = await adapter.fetchMultisig(MULTISIG_MIXED_PERMISSIONS);

    expect(summary.threshold).toBe(1);
    expect(summary.isControlled).toBe(false);
    // The live tip index at capture time — this multisig is real and active on mainnet, so this
    // will keep climbing; re-capture the fixture and update this if it ever changes underneath us.
    expect(summary.transactionIndex).toBe(353n);
    expect(summary.staleTransactionIndex).toBe(304n);
    expect(summary.members).toHaveLength(12);

    const fullPermission = summary.members.filter(
      (m) =>
        m.permissions.includes("Initiate") &&
        m.permissions.includes("Vote") &&
        m.permissions.includes("Execute"),
    );
    const initiateOnly = summary.members.filter(
      (m) => m.permissions.length === 1 && m.permissions[0] === "Initiate",
    );
    expect(fullPermission).toHaveLength(7);
    expect(initiateOnly).toHaveLength(5);
  });

  it("throws NotASquadsMultisigError for an address the fixture has no account for", async () => {
    const data = await loadFixtureFile(fixturePath("multisig-mixed-permissions"));
    const adapter = new SquadsV4Adapter(new FixtureRpcClient(data));

    await expect(
      adapter.fetchMultisig(address("11111111111111111111111111111111")),
    ).rejects.toThrow(NotASquadsMultisigError);
  });

  it("throws NotASquadsMultisigError for an account that exists but isn't owned by the Squads v4 program", async () => {
    // The vault PDA itself (a System-owned or program-owned account, never the multisig account)
    // is a realistic version of "pasted the wrong address" — reuse the transaction PDA from the
    // vault-transaction fixture, which is Squads-owned but is a VaultTransaction, not a Multisig.
    const data = await loadFixtureFile(fixturePath("vault-transaction"));
    const adapter = new SquadsV4Adapter(new FixtureRpcClient(data));

    await expect(
      adapter.fetchMultisig(address("MwXvLTjbQFFy5fMt5q9cU9HC92huDiriAk6KQUS6VLG")),
    ).rejects.toThrow(NotASquadsMultisigError);
  });
});

describe("SquadsV4Adapter.fetchProposalBundle, against real captured data", () => {
  it("fetches a live VaultTransaction bundle", async () => {
    const data = await loadFixtureFile(fixturePath("vault-transaction"));
    const adapter = new SquadsV4Adapter(new FixtureRpcClient(data));

    const bundle = await adapter.fetchProposalBundle(MULTISIG_MIXED_PERMISSIONS, 352n);

    expect(bundle.transactionKind).toBe("vault");
    expect(bundle.transactionAddress).toBe("MwXvLTjbQFFy5fMt5q9cU9HC92huDiriAk6KQUS6VLG");
    expect(bundle.proposal).not.toBeNull();
    expect(bundle.proposal?.address).toBe("5Y3bXvwEj3pSWDJV3LzDJNKEFcyeMBZe16ijD53RkSE7");
    expect(bundle.proposal?.status.kind).toBe("Executed");
    expect(bundle.proposal?.votes.approved.length).toBeGreaterThan(0);
    expect(bundle.batchTransactions).toBeUndefined();
  });

  it("throws for a ConfigTransaction whose account was closed after execution (a real on-chain state)", async () => {
    const data = await loadFixtureFile(fixturePath("config-transaction"));
    const adapter = new SquadsV4Adapter(new FixtureRpcClient(data));

    await expect(adapter.fetchProposalBundle(CONFIG_TRANSACTION_MULTISIG, 1n)).rejects.toThrow(
      /No transaction found/,
    );
  });
});

describe("SquadsV4Adapter.listProposals, against real captured data", () => {
  it("walks down from transactionIndex, filling in what it finds and leaving the rest null", async () => {
    const data = await loadFixtureFile(fixturePath("vault-transaction"));
    const adapter = new SquadsV4Adapter(new FixtureRpcClient(data));

    // The multisig's live tip is index 353 (see the fetchMultisig test above), but this fixture
    // only captured the transaction/proposal accounts for index 352 — a real transaction created
    // after that capture pushed the tip forward by one. The walk must still surface 352's data
    // and report 353 and 351 (not in the fixture) as "nothing found", not fail.
    const entries = await adapter.listProposals(MULTISIG_MIXED_PERMISSIONS, { limit: 3 });

    expect(entries).toHaveLength(3);
    expect(entries[0]?.transactionIndex).toBe(353n);
    expect(entries[0]?.transactionKind).toBeNull();
    expect(entries[0]?.transactionAddress).toBeNull();
    expect(entries[0]?.proposal).toBeNull();

    expect(entries[1]?.transactionIndex).toBe(352n);
    expect(entries[1]?.transactionKind).toBe("vault");
    expect(entries[1]?.proposal).not.toBeNull();
    expect(entries[1]?.isStale).toBe(false);

    expect(entries[2]?.transactionIndex).toBe(351n);
    expect(entries[2]?.transactionKind).toBeNull();
  });

  it("marks indices at or below staleTransactionIndex as stale", async () => {
    const data = await loadFixtureFile(fixturePath("multisig-mixed-permissions"));
    const adapter = new SquadsV4Adapter(new FixtureRpcClient(data));

    // staleTransactionIndex is 304 and transactionIndex is well above it, so walking down 50
    // indices from the tip crosses the staleness boundary.
    const entries = await adapter.listProposals(MULTISIG_MIXED_PERMISSIONS, { limit: 50 });

    const notStale = entries.filter((e) => !e.isStale);
    const stale = entries.filter((e) => e.isStale);
    expect(notStale.every((e) => e.transactionIndex > 304n)).toBe(true);
    expect(stale.every((e) => e.transactionIndex <= 304n)).toBe(true);
    expect(stale.length).toBeGreaterThan(0);
  });
});
