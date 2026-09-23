import type { RpcClient } from "../rpc/types.js";
import type { VaultTransactionMessage } from "../squads/generated/types/vaultTransactionMessage.js";
import {
  type DecodeOptions,
  decodeMessageWithLookups,
  type MessageDecodeResult,
} from "./decode.js";
import { fromVaultTransactionMessage } from "./message.js";

/**
 * Decodes the stored message of a Squads `VaultTransaction` (or `VaultBatchTransaction`) account:
 * the instructions the vault will execute if the proposal passes, with lookup tables resolved.
 */
export function decodeVaultTransactionMessage(
  rpc: RpcClient,
  message: VaultTransactionMessage,
  options: DecodeOptions = {},
): Promise<MessageDecodeResult> {
  return decodeMessageWithLookups(rpc, fromVaultTransactionMessage(message), options);
}
