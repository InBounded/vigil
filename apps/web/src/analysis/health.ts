import {
  type Clock,
  type Cluster,
  createRuleContext,
  type Finding,
  type MultisigSummary,
  RULES,
  runRules,
} from "@vigil-sol/core";

/** Core's "Fragile multisig" rule; the multisig page runs it on the multisig alone. */
const FRAGILE_MULTISIG = "VGL-W010";

/**
 * The multisig's own weaknesses (threshold of 1, a config authority), from core's VGL-W010 rule
 * over a context holding only the multisig: the page shows what the rule says, it does not judge.
 */
export async function multisigHealth(
  multisig: MultisigSummary,
  cluster: Cluster,
  clock: Clock,
): Promise<Finding[]> {
  const rule = RULES.find((candidate) => candidate.id === FRAGILE_MULTISIG);
  if (rule === undefined) {
    throw new Error(`${FRAGILE_MULTISIG} is missing from core's rules`);
  }
  const context = await createRuleContext({
    cluster,
    gaps: [],
    input: {
      kind: "squads-proposal",
      multisig: multisig.address,
      transactionIndex: multisig.transactionIndex,
    },
    instructions: [],
    multisig,
    now: BigInt(Math.floor(clock.now() / 1000)),
    programs: [],
    tokens: [],
  });
  return runRules(context, [rule]);
}
