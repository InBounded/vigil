export type DecodeErrorCode =
  | "TRUNCATED"
  | "TRAILING_BYTES"
  | "INVALID_TAG"
  | "INVALID_VALUE"
  | "INVALID_UTF8"
  | "INVALID_TRANSACTION";

/** A typed decoding failure. Decoders throw it; the pipeline turns it into an `AnalysisGap`. */
export class DecodeError extends Error {
  readonly code: DecodeErrorCode;

  constructor(code: DecodeErrorCode, message: string) {
    super(message);
    this.name = "DecodeError";
    this.code = code;
  }
}
