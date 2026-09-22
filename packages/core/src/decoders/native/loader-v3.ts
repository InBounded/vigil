import {
  LOADER_V3_PROGRAM_ADDRESS,
  LoaderV3Instruction,
  parseLoaderV3Instruction,
} from "@solana-program/loader-v3";
import { codamaProgramDecoder } from "./codama-program.js";

/**
 * BPF Upgradeable Loader. `@solana-program/loader-v3` covers tags 0–7, which is every variant of
 * `UpgradeableLoaderInstruction` in Agave's `bpf_loader` as of 2026-09-22 (see `docs/DECISIONS.md`
 * for the `Migrate`/`ExtendProgramChecked` discrepancy with `docs/reference.md`).
 */
export const loaderV3Decoder = codamaProgramDecoder({
  instructionEnum: LoaderV3Instruction,
  key: "loaderV3",
  label: "BPF Upgradeable Loader",
  parse: parseLoaderV3Instruction,
  programIds: [LOADER_V3_PROGRAM_ADDRESS],
});
