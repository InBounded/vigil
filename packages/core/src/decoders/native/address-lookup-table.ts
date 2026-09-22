import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
  AddressLookupTableInstruction,
  parseAddressLookupTableInstruction,
} from "@solana-program/address-lookup-table";
import { codamaProgramDecoder } from "./codama-program.js";

export const addressLookupTableDecoder = codamaProgramDecoder({
  instructionEnum: AddressLookupTableInstruction,
  key: "addressLookupTable",
  label: "Address Lookup Table Program",
  parse: parseAddressLookupTableInstruction,
  programIds: [ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS],
});
