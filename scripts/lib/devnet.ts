/**
 * Devnet / local-validator signing helpers for scripts (fixture recording now, the Phase 10 end-to-end test
 * later). This is the ONLY place in the repository allowed to sign or send transactions, under
 * the AGENTS.md carve-out:
 *   - scripts/ only: never imported by packages/core, packages/cli or apps/* (enforced by
 *     packages/core/src/signing-boundary.test.ts);
 *   - devnet or a local test validator only: `connectSigningCluster` accepts devnet (by its
 *     genesis hash, docs/reference.md §2) or a validator on a loopback address whose genesis hash
 *     is not mainnet's or testnet's, and refuses anything else, before any key exists;
 *   - in-memory throwaway keys only: `throwawayKeypair` generates a fresh key that is never
 *     written, logged or returned as bytes; only public keys are printed.
 *
 * Signing goes through @sqds/multisig 2.1.4 and @solana/web3.js 1.99.0 (root devDependencies),
 * whose calls were checked against the installed type declarations (see docs/DECISIONS.md).
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  type PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

export const DEVNET_RPC = "https://api.devnet.solana.com";
/** docs/reference.md §2. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** docs/reference.md §2: the clusters where value lives. Never signed on. */
const FORBIDDEN_GENESIS_HASHES: Readonly<Record<string, string>> = {
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class NotASigningClusterError extends Error {
  constructor(reason: string) {
    super(`refusing to sign: ${reason}`);
    this.name = "NotASigningClusterError";
  }
}

export type SigningCluster = "devnet" | "local";

/**
 * A connection, only after the endpoint proved to be devnet (genesis hash) or a local test
 * validator (loopback address, and a genesis hash that is not mainnet's or testnet's).
 */
export async function connectSigningCluster(
  url: string = DEVNET_RPC,
): Promise<{ readonly connection: Connection; readonly cluster: SigningCluster }> {
  const connection = new Connection(url, "confirmed");
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash === DEVNET_GENESIS_HASH) {
    return { cluster: "devnet", connection };
  }
  const forbidden = FORBIDDEN_GENESIS_HASHES[genesisHash];
  if (forbidden !== undefined) {
    throw new NotASigningClusterError(`the RPC is on ${forbidden}`);
  }
  if (!LOOPBACK_HOSTS.has(new URL(url).hostname)) {
    throw new NotASigningClusterError(
      `genesis hash ${genesisHash} is not devnet's, and ${new URL(url).hostname} is not a loopback address`,
    );
  }
  return { cluster: "local", connection };
}

/** A fresh key that lives only in this process's memory. */
export function throwawayKeypair(): Keypair {
  return Keypair.generate();
}

/**
 * Tops `account` up to `lamports`: an airdrop first; if the faucet refuses (it is often rate
 * limited), prints the public key and waits for someone to fund it, polling the balance, up to
 * `waitMinutes`. The key stays in memory meanwhile, so the process must keep running.
 */
export async function ensureFunded(
  connection: Connection,
  account: PublicKey,
  lamports: number,
  waitMinutes = 60,
  log: (text: string) => void = console.log,
): Promise<void> {
  if ((await connection.getBalance(account)) >= lamports) {
    return;
  }
  try {
    const signature = await connection.requestAirdrop(account, lamports);
    await confirm(connection, signature);
    log(`funded ${account.toBase58()} by airdrop`);
    return;
  } catch (error) {
    log(
      `airdrop refused (${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}).`,
    );
  }
  log(
    `FUND ME: send at least ${lamports / LAMPORTS_PER_SOL} devnet SOL to ${account.toBase58()} (waiting up to ${waitMinutes} min)`,
  );
  const deadline = Date.now() + waitMinutes * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    if ((await connection.getBalance(account)) >= lamports) {
      log(`funded ${account.toBase58()}`);
      return;
    }
  }
  throw new Error(`${account.toBase58()} was not funded within ${waitMinutes} minutes`);
}

async function confirm(connection: Connection, signature: string): Promise<void> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (result.value.err !== null) {
    throw new Error(`transaction ${signature} failed: ${JSON.stringify(result.value.err)}`);
  }
}

/** A Squads v4 multisig on devnet, driven by throwaway member keys. */
export class DevnetSquads {
  readonly connection: Connection;
  readonly address: PublicKey;
  readonly members: readonly Keypair[];
  readonly feePayer: Keypair;

  private constructor(
    connection: Connection,
    address: PublicKey,
    members: readonly Keypair[],
    feePayer: Keypair,
  ) {
    this.connection = connection;
    this.address = address;
    this.members = members;
    this.feePayer = feePayer;
  }

  /**
   * `multisigCreateV2`: `threshold` of `members.length`, every member with every permission,
   * autonomous (no config authority), no time lock unless given, no rent collector. The fee payer
   * creates it; the program's treasury comes from its ProgramConfig account.
   */
  static async create(
    connection: Connection,
    feePayer: Keypair,
    members: readonly Keypair[],
    threshold: number,
    timeLock = 0,
  ): Promise<DevnetSquads> {
    const createKey = throwawayKeypair();
    const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
    const [programConfigPda] = multisig.getProgramConfigPda({});
    const config = await multisig.accounts.ProgramConfig.fromAccountAddress(
      connection,
      programConfigPda,
    );
    const signature = await multisig.rpc.multisigCreateV2({
      configAuthority: null,
      connection,
      createKey,
      creator: feePayer,
      members: members.map((member) => ({
        key: member.publicKey,
        permissions: multisig.types.Permissions.all(),
      })),
      multisigPda,
      rentCollector: null,
      threshold,
      timeLock,
      treasury: config.treasury,
    });
    await confirm(connection, signature);
    return new DevnetSquads(connection, multisigPda, members, feePayer);
  }

  vault(index = 0): PublicKey {
    return multisig.getVaultPda({ index, multisigPda: this.address })[0];
  }

  /** Moves SOL from the fee payer into a vault, so a proposal can spend it. */
  async fundVault(lamports: number, index = 0): Promise<void> {
    const message = new TransactionMessage({
      instructions: [
        SystemProgram.transfer({
          fromPubkey: this.feePayer.publicKey,
          lamports,
          toPubkey: this.vault(index),
        }),
      ],
      payerKey: this.feePayer.publicKey,
      recentBlockhash: (await this.connection.getLatestBlockhash("confirmed")).blockhash,
    });
    const transaction = new VersionedTransaction(message.compileToV0Message());
    transaction.sign([this.feePayer]);
    const signature = await this.connection.sendTransaction(transaction);
    await confirm(this.connection, signature);
  }

  /** The multisig's next transaction index (current `transactionIndex` + 1). */
  async nextIndex(): Promise<bigint> {
    const account = await multisig.accounts.Multisig.fromAccountAddress(
      this.connection,
      this.address,
    );
    return BigInt(account.transactionIndex.toString()) + 1n;
  }

  /**
   * `vaultTransactionCreate` + `proposalCreate` (not a draft, so the proposal is Active), both
   * created by member 0. Returns the transaction index.
   */
  async propose(instructions: TransactionInstruction[], vaultIndex = 0): Promise<bigint> {
    const transactionIndex = await this.nextIndex();
    const creator = this.member(0);
    const message = new TransactionMessage({
      instructions,
      payerKey: this.vault(vaultIndex),
      recentBlockhash: (await this.connection.getLatestBlockhash("confirmed")).blockhash,
    });
    await confirm(
      this.connection,
      await multisig.rpc.vaultTransactionCreate({
        connection: this.connection,
        creator: creator.publicKey,
        ephemeralSigners: 0,
        feePayer: this.feePayer,
        multisigPda: this.address,
        signers: [creator],
        transactionIndex,
        transactionMessage: message,
        vaultIndex,
      }),
    );
    await confirm(
      this.connection,
      await multisig.rpc.proposalCreate({
        connection: this.connection,
        creator,
        feePayer: this.feePayer,
        isDraft: false,
        multisigPda: this.address,
        transactionIndex,
      }),
    );
    return transactionIndex;
  }

  async approve(transactionIndex: bigint, memberIndex: number): Promise<void> {
    await confirm(
      this.connection,
      await multisig.rpc.proposalApprove({
        connection: this.connection,
        feePayer: this.feePayer,
        member: this.member(memberIndex),
        multisigPda: this.address,
        transactionIndex,
      }),
    );
  }

  async execute(transactionIndex: bigint, memberIndex = 0): Promise<void> {
    const member = this.member(memberIndex);
    await confirm(
      this.connection,
      await multisig.rpc.vaultTransactionExecute({
        connection: this.connection,
        feePayer: this.feePayer,
        member: member.publicKey,
        multisigPda: this.address,
        signers: [member],
        transactionIndex,
      }),
    );
  }

  private member(index: number): Keypair {
    const member = this.members[index];
    if (member === undefined) {
      throw new Error(`no member ${index}`);
    }
    return member;
  }
}
