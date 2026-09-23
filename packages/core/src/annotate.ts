import { applyLabels, buildLabels, type LabelContext } from "./labels/labels.js";
import type { AnalysisGap, DecodedInstruction } from "./report.js";
import type { RpcClient } from "./rpc/types.js";
import { enrichTokenAmounts, type TokenInfo } from "./tokens/enrich.js";

export interface AnnotationResult {
  readonly instructions: DecodedInstruction[];
  readonly tokens: TokenInfo[];
  readonly gaps: AnalysisGap[];
}

/**
 * Everything added on top of decoding: token amounts made human-readable (mint, decimals, registry
 * symbol or declared name) and account labels (this multisig's vaults and members, registry
 * programs and mints, sysvars, the user's own labels).
 */
export async function annotateInstructions(
  rpc: RpcClient,
  instructions: readonly DecodedInstruction[],
  context: LabelContext,
): Promise<AnnotationResult> {
  const enriched = await enrichTokenAmounts(rpc, instructions, context.cluster);
  const tokenAccountOwners = new Map(
    [...enriched.tokenAccounts].map(([address, info]) => [address, info.owner] as const),
  );
  const labels = await buildLabels({ ...context, tokenAccountOwners });
  return {
    gaps: enriched.gaps,
    instructions: applyLabels(enriched.instructions, labels, context.cluster),
    tokens: enriched.tokens,
  };
}
