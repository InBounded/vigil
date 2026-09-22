import {
  parseSystemInstruction,
  SYSTEM_PROGRAM_ADDRESS,
  SystemInstruction,
} from "@solana-program/system";
import { codamaProgramDecoder } from "./codama-program.js";

export const systemDecoder = codamaProgramDecoder({
  instructionEnum: SystemInstruction,
  key: "system",
  label: "System Program",
  parse: parseSystemInstruction,
  programIds: [SYSTEM_PROGRAM_ADDRESS],
});
