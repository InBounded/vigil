Technical reference

Compiled with knowledge current as of May 2026. Every value must be confirmed against the official source before use. If they conflict, the official source wins.

1. Program addresses
Program    Address
System Program    11111111111111111111111111111111
SPL Token    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
Token-2022    TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
Associated Token Account    ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
Compute Budget    ComputeBudget111111111111111111111111111111
BPF Upgradeable Loader    BPFLoaderUpgradeab1e11111111111111111111111
Address Lookup Table    AddressLookupTab1e1111111111111111111111111
Memo (v2)    MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr
Stake    Stake11111111111111111111111111111111111111
Vote    Vote111111111111111111111111111111111111111
Metaplex Token Metadata    metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
Program Metadata    ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S (confirm)
Squads v4    SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf (mainnet and devnet; confirm)
Squads v3 (legacy, out of MVP scope)    SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu

Initial token registry (confirm): USDC EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, USDT Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB, wSOL So11111111111111111111111111111111111111112.

2. Genesis hashes (cluster detection)
Cluster    Genesis hash
mainnet-beta    5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
devnet    EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
testnet    4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY
3. Free endpoints
Public mainnet RPC: https://api.mainnet-beta.solana.com (tight rate limits; no heavy getProgramAccounts).
Public devnet RPC: https://api.devnet.solana.com.
Program verification (OtterSec): https://verify.osec.io/status/<PROGRAM_ID> (confirm endpoint and response shape).
Free-tier RPC providers (for the proxy): pick one and confirm current limits.
4. RPC method allowlist

getAccountInfo, getMultipleAccounts, getGenesisHash, getSlot, getSignaturesForAddress, getTransaction, simulateTransaction (only with sigVerify: false). Additions require justification in docs/DECISIONS.md. Sending methods are never allowed.

5. Squads v4 PDAs

All seeds start with the UTF-8 prefix "multisig". u64 little-endian (8 bytes), u32 LE (4 bytes), u8 one byte.

Account    Seeds
Multisig    "multisig", "multisig", createKey
Vault    "multisig", multisig, "vault", vaultIndex: u8
Transaction    "multisig", multisig, "transaction", transactionIndex: u64
Proposal    "multisig", multisig, "transaction", transactionIndex: u64, "proposal"
Ephemeral signer    "multisig", transactionPda, "ephemeral_signer", index: u8
Batch transaction    "multisig", multisig, "transaction", batchIndex: u64, "batch_transaction", txIndex: u32
Spending limit    "multisig", multisig, "spending_limit", createKey

Confirm against the program source and the get*Pda functions of @sqds/multisig.

6. Squads v4 accounts (always use the IDL / generated client)
Multisig: createKey, configAuthority (default address = autonomous; any other = controlled), threshold (u16), timeLock (u32 seconds), transactionIndex (u64), staleTransactionIndex (u64), rentCollector (optional), bump, members ({ key, permissions: { mask: u8 } }).
Permission mask: Initiate = 1, Vote = 2, Execute = 4.
Proposal: multisig, transactionIndex, status (Draft, Active, Rejected, Approved, Executing, Executed, Cancelled, with timestamp), approved[], rejected[], cancelled[].
VaultTransaction: multisig, creator, index, vaultIndex, ephemeralSignerBumps, message with numSigners, numWritableSigners, numWritableNonSigners, accountKeys, instructions (programIdIndex, accountIndexes, data), addressTableLookups (accountKey, writableIndexes, readonlyIndexes). The message is immutable after creation.
ConfigTransaction: actions (AddMember, RemoveMember, ChangeThreshold, SetTimeLock, AddSpendingLimit, RemoveSpendingLimit, SetRentCollector; confirm full list in IDL).
Batch / VaultBatchTransaction: confirm in IDL.
Anchor account discriminator: first 8 bytes of sha256("account:<AccountName>"). Compute it, never copy from memory.
7. BPF Upgradeable Loader

Account state (bincode enum, u32 LE tag):

Tag    Type    Content    Header size
0    Uninitialized    —    4
1    Buffer    authority: Option<Pubkey> (1 + 32)    37 (program bytes start here)
2    Program    programdataAddress: Pubkey    36
3    ProgramData    slot: u64, upgradeAuthority: Option<Pubkey>    45 (program bytes start here)

Instructions (u32 LE tag): 0 InitializeBuffer, 1 Write, 2 DeployWithMaxDataLen, 3 Upgrade, 4 SetAuthority, 5 Close, 6 ExtendProgram, 7 SetAuthorityChecked; newer versions add 8 Migrate, 9 ExtendProgramChecked (confirm).

Accounts (confirm in Agave):

Upgrade: 0 programdata (w), 1 program (w), 2 buffer (w), 3 spill (w), 4 rent sysvar, 5 clock sysvar, 6 authority (signer).
SetAuthority: 0 account (buffer or programdata, w), 1 current authority (signer), 2 new authority (optional; absent = none, program becomes immutable).
SetAuthorityChecked: 0 account (w), 1 current authority (signer), 2 new authority (signer).
Close: 0 account to close (w), 1 lamports recipient (w), 2 authority (signer, optional), 3 program (when closing programdata).

Loader rule: for Upgrade to succeed, the buffer authority must equal the program's upgrade authority.

8. SPL Token base layout (same in Token-2022)
Token account (165 bytes base): mint 0–32, owner 32–64, amount (u64 LE) 64–72, delegate (COption 4+32) 72–108, state 108, isNative (COption 4+8) 109–121, delegatedAmount 121–129, closeAuthority (COption 4+32) 129–165. Token-2022 extensions follow.
Mint (82 bytes base): mintAuthority (COption 4+32) 0–36, supply (u64) 36–44, decimals (u8) 44, isInitialized 45, freezeAuthority (COption 4+32) 46–82.
Relevant tags: 3 Transfer, 4 Approve, 6 SetAuthority, 7 MintTo, 8 Burn, 9 CloseAccount, 12 TransferChecked, 13 ApproveChecked. Prefer @solana-program/token* parsers.
9. Other layouts
Address Lookup Table: 56-byte header (type u32, deactivationSlot u64, lastExtendedSlot u64, lastExtendedSlotStartIndex u8, authority Option<Pubkey>, padding), then 32-byte addresses. Existing entries never change; entries are only appended.
System Program (u32 tag): 0 CreateAccount, 1 Assign, 2 Transfer, 3 CreateAccountWithSeed, 4 AdvanceNonceAccount, 5 WithdrawNonceAccount, 6 InitializeNonceAccount, 7 AuthorizeNonceAccount, 8 Allocate, 9 AllocateWithSeed, 10 AssignWithSeed, 11 TransferWithSeed, 12 UpgradeNonceAccount.
Stake (u32 tag): 0 Initialize, 1 Authorize, 2 DelegateStake, 3 Split, 4 Withdraw, 5 Deactivate, 6 SetLockup, 7 Merge, 8 AuthorizeWithSeed, 9 InitializeChecked, 10 AuthorizeChecked, 11 AuthorizeCheckedWithSeed, 12 SetLockupChecked (confirm the rest).
Compute Budget (u8 tag): 1 RequestHeapFrame, 2 SetComputeUnitLimit, 3 SetComputeUnitPrice, 4 SetLoadedAccountsDataSizeLimit.
10. On-chain Anchor IDL
Address: createWithSeed(base, "anchor:idl", programId), where base is the program's PDA with empty seeds.
Layout: discriminator (8), authority (32), data length (u32 LE), zlib-compressed IDL JSON.
Legacy (pre-0.30) and new (0.30+) formats differ: convert with @codama/nodes-from-anchor.
Legacy instruction discriminator: first 8 bytes of sha256("global:<snake_case_name>"); explicit in the new format.
11. String sanitization

Remove or flag:

C0/C1 control characters (U+0000–U+001F, U+007F–U+009F), except newline in memos.
Bidi formatting: U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C.
Zero-width: U+200B–U+200D, U+2060, U+FEFF.
Flag (do not remove) non-ASCII characters in token symbols and mixed scripts (Latin with Cyrillic/Greek) in names.
12. Executable hash (solana-verify compatible)

Expected, to be confirmed in the solana-verifiable-build source: SHA-256 of the program bytes (after the 45-byte programdata header or the 37-byte buffer header), with trailing zero bytes removed. Validate against real output of solana-verify get-program-hash and solana-verify get-buffer-hash.
