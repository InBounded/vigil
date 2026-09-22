import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FixtureRpcClient } from "./fixture-client.js";
import { loadFixtureFile, loadFixtureFiles } from "./fixture-file.js";

const SQUADS_V4_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/${name}.json`, import.meta.url));
}

describe("loadFixtureFile against real captured fixtures", () => {
  it("loads the multisig-mixed-permissions fixture and serves it via FixtureRpcClient", async () => {
    const data = await loadFixtureFile(fixturePath("multisig-mixed-permissions"));
    const rpc = new FixtureRpcClient(data);
    const address = "3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt" as const;

    const result = await rpc.getAccountInfo(address);
    expect(result.value).not.toBeNull();
    expect(result.value?.owner).toBe(SQUADS_V4_PROGRAM);
    expect(result.value?.lamports).toBeGreaterThan(0n);
    expect(result.contextSlot).toBeGreaterThan(0n);
  });

  it("loads the vault-transaction fixture with all three related accounts", async () => {
    const data = await loadFixtureFile(fixturePath("vault-transaction"));
    const rpc = new FixtureRpcClient(data);
    const addresses = [
      "3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt",
      "MwXvLTjbQFFy5fMt5q9cU9HC92huDiriAk6KQUS6VLG",
      "5Y3bXvwEj3pSWDJV3LzDJNKEFcyeMBZe16ijD53RkSE7",
    ] as const;

    const result = await rpc.getMultipleAccounts(addresses);
    expect(result.value).toHaveLength(3);
    for (const account of result.value) {
      expect(account).not.toBeNull();
      expect(account?.owner).toBe(SQUADS_V4_PROGRAM);
    }
  });

  it("loads the config-transaction fixture's historical transaction, whose account is now closed", async () => {
    const data = await loadFixtureFile(fixturePath("config-transaction"));
    const rpc = new FixtureRpcClient(data);
    const signature =
      "2HU86rfvwQUVoHtBVD2APHY9uEWk5RCw4tceTM8h2NHUzVxm6YAMQSLa5tTd4AWJjgNnUy1f79ndPGZzucQt3Zz1" as const;

    const tx = await rpc.getTransaction(signature);
    expect(tx).not.toBeNull();
    expect(tx?.err).toBeNull();
    expect(tx?.transactionBase64.length).toBeGreaterThan(0);

    // The multisig account was still live at capture time, even though its ConfigTransaction/
    // Proposal were closed in the same atomic transaction.
    const multisig = await rpc.getAccountInfo("4AUG3JkY43g39avoD5e66BVKCj5RDZRGQoKgGyNcDJnx");
    expect(multisig.value?.owner).toBe(SQUADS_V4_PROGRAM);
  });

  it("loads the second config-transaction fixture the same way", async () => {
    const data = await loadFixtureFile(fixturePath("config-transaction-2"));
    const rpc = new FixtureRpcClient(data);
    const signature =
      "3w38dUfnzfheZaxPwjBmqcABue8RBvNx1EthKS55u8JXZXxzMcAqnbZ5zbiQNBeQkGtefYsqdhDj1fwPzG6RBgr1" as const;

    const tx = await rpc.getTransaction(signature);
    expect(tx).not.toBeNull();
    expect(tx?.err).toBeNull();
  });

  it("merges multiple fixture files into one FixtureRpcClient", async () => {
    const data = await loadFixtureFiles([
      fixturePath("multisig-mixed-permissions"),
      fixturePath("vault-transaction"),
    ]);
    const rpc = new FixtureRpcClient(data);
    const result = await rpc.getAccountInfo("MwXvLTjbQFFy5fMt5q9cU9HC92huDiriAk6KQUS6VLG");
    expect(result.value).not.toBeNull();
  });

  it("resolves an address absent from the fixture to null, like a real RPC would", async () => {
    const data = await loadFixtureFile(fixturePath("multisig-mixed-permissions"));
    const rpc = new FixtureRpcClient(data);
    const result = await rpc.getAccountInfo("11111111111111111111111111111111");
    expect(result.value).toBeNull();
  });
});
