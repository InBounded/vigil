import { type Address, getBase64Encoder, type ReadonlyUint8Array } from "@solana/kit";
import { toHex } from "../decoders/bytes.js";
import type { ProgramDecoder } from "../decoders/types.js";
import type { AnalysisGapCode } from "../report.js";
import type { AccountInfo, RpcClient } from "../rpc/types.js";
import {
  type IdlAccountProblem,
  type IdlAccountResult,
  type IdlPayload,
  parseAnchorIdlAccount,
  parseProgramMetadataAccount,
} from "./accounts.js";
import { findAnchorIdlAddress, findProgramMetadataIdlAddress } from "./addresses.js";
import { type IdlSource, idlProgramDecoder } from "./decoder.js";
import { inflateBounded } from "./inflate.js";
import { type IdlFormat, loadIdl } from "./load.js";

/**
 * Where decompressed, validated IDL JSON is kept between analyses, keyed by
 * `<program>:<sha256 of the IDL account data>` — so any change to the account is a new key. What a
 * cache returns is still parsed and validated like fresh chain data. Implementations: IndexedDB in
 * the web app, `$XDG_CACHE_HOME/vigil` in the CLI. Failures are ignored (the cache is optional).
 */
export interface IdlCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, json: string): Promise<void>;
}

export interface IdlOptions {
  readonly cache?: IdlCache;
  /** Deadline for the IDL account read; default {@link DEFAULT_IDL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

export const DEFAULT_IDL_TIMEOUT_MS = 10_000;

export type IdlEntry =
  | {
      readonly status: "ok";
      readonly decoder: ProgramDecoder;
      readonly source: IdlSource;
      readonly format: IdlFormat;
      /** SHA-256 (hex) of the IDL account data the decoder was built from. */
      readonly accountHash: string;
    }
  | { readonly status: "none" }
  | { readonly status: "error"; readonly code: AnalysisGapCode; readonly message: string };

const base64Bytes = getBase64Encoder();

let anchorDiscriminator: Promise<Uint8Array> | undefined;

/**
 * `sha256("internal:IdlAccount")[..8]`, computed (never copied). Not `account:` as for ordinary
 * Anchor accounts (`docs/reference.md` §6): `IdlAccount` is declared `#[account("internal")]`, and a
 * namespace argument replaces the `account` prefix (anchor `lang/attribute/account/src/lib.rs`,
 * `gen_discriminator(namespace, account_name)`, commit cc9f6b1c). Matches every real IDL account
 * in `fixtures/idl-programs.json`.
 */
function anchorIdlDiscriminator(): Promise<Uint8Array> {
  anchorDiscriminator ??= sha256(new TextEncoder().encode("internal:IdlAccount")).then((hash) =>
    hash.subarray(0, 8),
  );
  return anchorDiscriminator;
}

async function sha256(bytes: ReadonlyUint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
}

/**
 * Finds and loads the IDL of each program with one `getMultipleAccounts` call: the canonical
 * Program Metadata account (seed `idl`) first, then the legacy Anchor IDL account. A program with
 * neither is `none`; anything unusable is an `error` carrying the gap to report.
 */
export async function loadProgramIdls(
  rpc: RpcClient,
  programs: readonly Address[],
  options: IdlOptions = {},
): Promise<Map<Address, IdlEntry>> {
  const entries = new Map<Address, IdlEntry>();
  if (programs.length === 0) {
    return entries;
  }
  const metadataAddresses = await Promise.all(programs.map(findProgramMetadataIdlAddress));
  const anchorAddresses = await Promise.all(programs.map(findAnchorIdlAddress));

  let accounts: ReadonlyArray<AccountInfo | null>;
  try {
    const timeoutMs = options.timeoutMs ?? DEFAULT_IDL_TIMEOUT_MS;
    ({ value: accounts } = await withTimeout(
      rpc.getMultipleAccounts([...metadataAddresses, ...anchorAddresses]),
      timeoutMs,
    ));
  } catch (error) {
    for (const program of programs) {
      entries.set(program, {
        code: "IDL_FETCH_FAILED",
        message: `the program's IDL accounts could not be read: ${describe(error)}`,
        status: "error",
      });
    }
    return entries;
  }

  const discriminator = await anchorIdlDiscriminator();
  for (const [i, program] of programs.entries()) {
    const metadata = accounts[i] ?? null;
    const anchor = accounts[programs.length + i] ?? null;
    const fromMetadata =
      metadata === null
        ? null
        : parseProgramMetadataAccount(metadata.owner, bytesOf(metadata), program);
    const fromAnchor =
      anchor === null
        ? null
        : parseAnchorIdlAccount(anchor.owner, bytesOf(anchor), program, discriminator);

    // Program Metadata first; the Anchor account is the fallback, also when the Program Metadata
    // IDL is unusable. With neither usable, the Program Metadata problem is the one reported.
    let chosen: { result: IdlAccountResult; source: IdlSource; account: AccountInfo } | null = null;
    if (fromMetadata?.ok === true && metadata !== null) {
      chosen = { account: metadata, result: fromMetadata, source: "program-metadata" };
    } else if (fromAnchor?.ok === true && anchor !== null) {
      chosen = { account: anchor, result: fromAnchor, source: "anchor-idl-account" };
    }
    if (chosen === null || !chosen.result.ok) {
      const problem = fromMetadata?.ok === false ? fromMetadata.problem : undefined;
      const anchorProblem = fromAnchor?.ok === false ? fromAnchor.problem : undefined;
      const reported = problem ?? anchorProblem;
      entries.set(program, reported === undefined ? { status: "none" } : problemEntry(reported));
      continue;
    }
    entries.set(
      program,
      await buildEntry(
        program,
        chosen.source,
        bytesOf(chosen.account),
        chosen.result.payload,
        options.cache,
      ),
    );
  }
  return entries;
}

async function buildEntry(
  program: Address,
  source: IdlSource,
  accountData: ReadonlyUint8Array,
  payload: IdlPayload,
  cache: IdlCache | undefined,
): Promise<IdlEntry> {
  const accountHash = toHex(await sha256(accountData));
  const key = `${program}:${accountHash}`;
  let json = await cache?.get(key).catch(() => undefined);
  const fromCache = json !== undefined;
  try {
    if (json === undefined) {
      const bytes =
        payload.compression === "none"
          ? payload.bytes
          : inflateBounded(payload.bytes, payload.compression);
      json = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    }
    const { root, format } = loadIdl(json, program);
    if (!fromCache) {
      await cache?.set(key, json).catch(() => undefined);
    }
    return {
      accountHash,
      decoder: idlProgramDecoder(root, program, source),
      format,
      source,
      status: "ok",
    };
  } catch (error) {
    return {
      code: "IDL_INVALID",
      message: `the program's IDL could not be used: ${describe(error)}`,
      status: "error",
    };
  }
}

function problemEntry(problem: IdlAccountProblem): IdlEntry {
  switch (problem.kind) {
    case "at-url":
      return {
        code: "IDL_AT_URL",
        message:
          "The program publishes its IDL (its own description of its instructions) at an external " +
          "URL. Vigil never opens URLs from the chain, so this instruction could not be decoded.",
        status: "error",
      };
    case "external":
      return {
        code: "IDL_UNSUPPORTED",
        message:
          "The program's IDL is stored in another account (Program Metadata external data source), " +
          "which Vigil does not read yet.",
        status: "error",
      };
    case "unsupported":
      return { code: "IDL_UNSUPPORTED", message: problem.reason, status: "error" };
    case "invalid":
      return { code: "IDL_INVALID", message: problem.reason, status: "error" };
  }
}

function bytesOf(account: AccountInfo): ReadonlyUint8Array {
  return base64Bytes.encode(account.dataBase64);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
