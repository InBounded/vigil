import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  ComputeBudgetInstruction,
  parseComputeBudgetInstruction,
} from "@solana-program/compute-budget";
import { codamaProgramDecoder } from "./codama-program.js";

export const computeBudgetDecoder = codamaProgramDecoder({
  instructionEnum: ComputeBudgetInstruction,
  key: "computeBudget",
  label: "Compute Budget Program",
  parse: parseComputeBudgetInstruction,
  programIds: [COMPUTE_BUDGET_PROGRAM_ADDRESS],
});
