/**
 * A problem the user can fix: what went wrong and what to do about it. Exit code 3. Messages
 * never contain an RPC URL (see `secrets.ts`).
 */
export class CliError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "CliError";
    this.hint = hint;
  }
}

/** Exit codes (documented in `--help` and the README). */
export const EXIT = {
  /** Nothing at the `--fail-on` level. */
  ok: 0,
  /** Warnings, with `--fail-on warning`. */
  warning: 1,
  /** A critical finding (unless `--fail-on never`). */
  critical: 2,
  /** Runtime error or invalid input. */
  error: 3,
  /** Incomplete analysis and no critical finding (unless `--fail-on never`). */
  incomplete: 4,
} as const;
