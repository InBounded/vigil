#!/usr/bin/env -S pnpm exec tsx
/**
 * Builds the UNSIGNED legacy transaction used by the web app's hostile-string test and prints it
 * as base64 (no signature is ever produced: the signature slot stays zero, and nothing is sent).
 * Pasted raw transactions are attacker-controlled input, so this is what an attacker could paste:
 * one Memo (v2) instruction whose text holds HTML, a script tag, bidi overrides, zero-width
 * characters and a Unicode tag character. The analysis of it is then captured live from mainnet
 * with `scripts/capture-reports.ts --raw-base64-file` (real RPC and simulation answers).
 *
 * Usage: pnpm exec tsx scripts/build-hostile-memo-transaction.ts > fixtures/web/hostile-memo.base64
 */
import {
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

/** A real system-owned mainnet account with a SOL balance (from fixtures/cli/raw-usdc-transfer.json). */
const FEE_PAYER = address("EmpaqxdFbQU8CoCFXCL2WiEksm8PvYksihocVZuq9p1s");
const MEMO_V2 = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Replaced by the RPC during simulation (`replaceRecentBlockhash: true`). */
const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111" as Blockhash;

/** Every hostile piece, written as escapes so no invisible character sits in this source file. */
export const HOSTILE_MEMO = [
  "Refund <img src=x onerror=alert(1)>",
  '<script>alert("vigil")</script>',
  "<a href=javascript:alert(1)>claim</a>",
  "file: \u202Egpj.exe",
  "pay US\u200BDC",
  "to \u2066victim\u2069",
  "\u200Fok \u2060 \uFEFF \uDB40\uDC41",
].join(" ");

const text = new TextEncoder().encode(HOSTILE_MEMO);
const message = pipe(
  createTransactionMessage({ version: "legacy" }),
  (m) => setTransactionMessageFeePayer(FEE_PAYER, m),
  (m) =>
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: PLACEHOLDER_BLOCKHASH, lastValidBlockHeight: 0n },
      m,
    ),
  (m) => appendTransactionMessageInstructions([{ data: text, programAddress: MEMO_V2 }], m),
);
process.stdout.write(`${getBase64EncodedWireTransaction(compileTransaction(message))}\n`);
