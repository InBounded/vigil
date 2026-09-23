import type { RootNode } from "@codama/nodes";
import { type AnchorIdl, rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import type { Address } from "@solana/kit";

/**
 * Turns IDL JSON text (hostile input) into a Codama `RootNode` for one program. `JSON.parse` only;
 * no code from the IDL is ever evaluated. Accepted: Anchor IDLs, legacy (pre-0.30) and new
 * (`metadata.spec: "0.1.0"`), converted with `@codama/nodes-from-anchor`, and Codama root nodes
 * (`standard: "codama"`, as some programs publish through Program Metadata).
 */

export class IdlLoadError extends Error {
  readonly code = "IDL_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "IdlLoadError";
  }
}

export type IdlFormat = "anchor-legacy" | "anchor" | "codama";

export interface LoadedIdl {
  readonly root: RootNode;
  readonly format: IdlFormat;
}

/** Every IDL name that can reach a report (instruction, account, argument, field, variant, type). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadIdl(json: string, program: Address): LoadedIdl {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    throw new IdlLoadError("the IDL is not valid JSON");
  }
  if (!isObject(document)) {
    throw new IdlLoadError("the IDL is not a JSON object");
  }

  let root: RootNode;
  let format: IdlFormat;
  if (document.standard === "codama" && document.kind === "rootNode") {
    if (!isObject(document.program) || document.program.kind !== "programNode") {
      throw new IdlLoadError("the Codama IDL has no program node");
    }
    format = "codama";
    root = document as unknown as RootNode;
  } else {
    if (!Array.isArray(document.instructions)) {
      throw new IdlLoadError("the Anchor IDL has no instruction list");
    }
    // Checked on the raw JSON too: the conversion camel-cases names and silently drops characters
    // it does not understand, so a look-alike name would otherwise come out as a different ASCII
    // name instead of being refused.
    checkRawAnchorNames(document);
    const metadata = isObject(document.metadata) ? document.metadata : undefined;
    format = metadata?.spec === "0.1.0" ? "anchor" : "anchor-legacy";
    if (format === "anchor" && typeof document.address !== "string") {
      throw new IdlLoadError("the Anchor IDL has no program address");
    }
    try {
      root = rootNodeFromAnchor(document as unknown as AnchorIdl);
    } catch (error) {
      throw new IdlLoadError(`the Anchor IDL could not be converted: ${message(error)}`);
    }
  }

  const declared = root.program.publicKey;
  if (declared !== "" && declared !== program) {
    throw new IdlLoadError(`the IDL declares program ${declared}, not ${program}`);
  }
  checkIdentifiers(root);
  checkNoZeroSizedRepetition(root);
  // Legacy Anchor IDLs usually carry no address; the IDL account itself is derived from the
  // program, so that is the program it describes. Other programs bundled in the IDL are dropped:
  // this IDL may only ever describe its own program.
  return {
    format,
    root: { ...root, additionalPrograms: [], program: { ...root.program, publicKey: program } },
  };
}

function checkRawAnchorNames(document: { [key: string]: Json }): void {
  walk(document, (node) => {
    if ("name" in node && typeof node.name === "string" && !IDENTIFIER.test(node.name)) {
      throw new IdlLoadError(
        "the IDL contains a name that is not a plain ASCII identifier (possible spoofing)",
      );
    }
  });
}

function checkIdentifiers(root: RootNode): void {
  walk(root, (node) => {
    if (typeof node.kind === "string" && node.kind.endsWith("Node") && "name" in node) {
      const { name } = node;
      if (typeof name !== "string" || !IDENTIFIER.test(name)) {
        throw new IdlLoadError(
          "the IDL contains a name that is not a plain ASCII identifier (possible spoofing)",
        );
      }
    }
  });
}

/**
 * An array, set or map whose items take zero bytes would make the decoder loop once per declared
 * item without consuming input (up to 2^32 times for a `u32` count): a hang, not a failure.
 * Synchronous decoding cannot be interrupted by a timeout, so such IDLs are refused up front.
 */
function checkNoZeroSizedRepetition(root: RootNode): void {
  const types = new Map<string, unknown>();
  for (const definedType of root.program.definedTypes ?? []) {
    types.set(definedType.name, definedType.type);
  }
  const zeroSized = (node: unknown, visiting: Set<string>): boolean => {
    if (!isObject(node)) {
      return false;
    }
    switch (node.kind) {
      // An empty struct or tuple may be emitted without its `fields` / `items` key at all.
      case "structTypeNode":
        return (Array.isArray(node.fields) ? node.fields : []).every(
          (field) => isObject(field) && zeroSized(field.type, visiting),
        );
      case "tupleTypeNode":
        return (Array.isArray(node.items) ? node.items : []).every((item) =>
          zeroSized(item, visiting),
        );
      case "fixedSizeTypeNode":
        return node.size === 0;
      case "arrayTypeNode":
        return (
          (isObject(node.count) &&
            node.count.kind === "fixedCountNode" &&
            node.count.value === 0) ||
          zeroSized(node.item, visiting)
        );
      case "definedTypeLinkNode": {
        const name = typeof node.name === "string" ? node.name : "";
        if (visiting.has(name)) {
          return false;
        }
        return zeroSized(types.get(name), new Set([...visiting, name]));
      }
      default:
        return false;
    }
  };
  walk(root, (node) => {
    const repeated =
      node.kind === "arrayTypeNode" || node.kind === "setTypeNode"
        ? [node.item]
        : node.kind === "mapTypeNode"
          ? [node.key, node.value]
          : [];
    const unbounded = !(
      isObject(node.count) &&
      node.count.kind === "fixedCountNode" &&
      typeof node.count.value === "number" &&
      node.count.value <= 1024
    );
    if (unbounded && repeated.length > 0 && repeated.every((item) => zeroSized(item, new Set()))) {
      throw new IdlLoadError("the IDL declares a repeated type whose items take no bytes");
    }
  });
}

function walk(value: unknown, visit: (node: { [key: string]: Json }) => void): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    // Pushed one by one: spreading a huge array (a 5 MB IDL can hold one) overflows the call stack.
    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
    } else if (isObject(current)) {
      visit(current);
      for (const item of Object.values(current)) {
        stack.push(item);
      }
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
