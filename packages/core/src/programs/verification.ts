import type { Address } from "@solana/kit";
import type { Clock } from "../io/clock.js";
import { type HttpClient, HttpError } from "../io/http.js";
import type { AnalysisGap, ProgramInfo, VerificationDetails } from "../report.js";

/**
 * OtterSec's program-verification API, as used by solana-verify itself:
 * `GET https://verify.osec.io/status/<PROGRAM_ID>` (solana-foundation/solana-verifiable-build
 * `src/api/client.rs`, `REMOTE_SERVER_URL`, at fef59512). The response fields read here were
 * confirmed against that repo's `src/api/models.rs` (`RemoteStatusResponse`) and live answers;
 * the live API also returns `message`, `is_frozen` and `is_closed`, which are not used.
 */
export const VERIFICATION_API = "https://verify.osec.io/status/";
export const VERIFICATION_TIMEOUT_MS = 8_000;
export const VERIFICATION_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** The parts of a `/status` answer Vigil uses, after validation. */
export interface VerificationStatus {
  readonly isVerified: boolean;
  /** Hash of the verified build (`executable_hash`), lower-case hex, when given. */
  readonly executableHash?: string;
  readonly onChainHash?: string;
  readonly repoUrl?: string;
  readonly commit?: string;
  readonly lastVerifiedAt?: string;
}

/** In-memory cache of answers for one hour (of the injected clock). Failures are never cached. */
export class VerificationCache {
  readonly #entries = new Map<
    Address,
    { readonly at: number; readonly status: VerificationStatus }
  >();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  get(program: Address): VerificationStatus | undefined {
    const entry = this.#entries.get(program);
    if (entry === undefined) {
      return undefined;
    }
    if (this.#clock.now() - entry.at >= VERIFICATION_CACHE_TTL_MS) {
      this.#entries.delete(program);
      return undefined;
    }
    return entry.status;
  }

  set(program: Address, status: VerificationStatus): void {
    this.#entries.set(program, { at: this.#clock.now(), status });
  }
}

export interface VerificationOptions {
  /** `false`: never contact the API (user choice); every program is `not-checked`, one gap says why. */
  readonly enabled: boolean;
  readonly http: HttpClient;
  readonly cache: VerificationCache;
}

export class VerificationResponseError extends Error {
  readonly code = "VERIFICATION_RESPONSE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "VerificationResponseError";
  }
}

/**
 * Validates a `/status` body. Anything unexpected is an error (the program is then `unknown`), never
 * a guess. `repo_url` is kept only if it is a plain `https://github.com/...` URL and `commit` only if
 * it is a 40-character hex commit (the live API also returns `"None"` and `/tree/<commit>` URLs).
 */
export function parseVerificationStatus(text: string): VerificationStatus {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new VerificationResponseError("the answer is not JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new VerificationResponseError("the answer is not a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.is_verified !== "boolean") {
    throw new VerificationResponseError("the answer has no boolean `is_verified`");
  }
  const hash = (value: unknown, field: string): string | undefined => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
      throw new VerificationResponseError(`\`${field}\` is not a SHA-256 hex hash`);
    }
    return value.toLowerCase();
  };
  const executableHash = hash(record.executable_hash, "executable_hash");
  const onChainHash = hash(record.on_chain_hash, "on_chain_hash");
  const repoUrl = githubUrl(record.repo_url);
  const commit =
    typeof record.commit === "string" && /^[0-9a-fA-F]{40}$/.test(record.commit)
      ? record.commit.toLowerCase()
      : undefined;
  const lastVerifiedAt =
    typeof record.last_verified_at === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/.test(
      record.last_verified_at,
    )
      ? record.last_verified_at
      : undefined;
  return {
    isVerified: record.is_verified,
    ...(executableHash === undefined ? {} : { executableHash }),
    ...(onChainHash === undefined ? {} : { onChainHash }),
    ...(repoUrl === undefined ? {} : { repoUrl }),
    ...(commit === undefined ? {} : { commit }),
    ...(lastVerifiedAt === undefined ? {} : { lastVerifiedAt }),
  };
}

const GITHUB_PATH = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]*)?$/;

/**
 * A link shown to users: only `https://github.com/<owner>/<repo>[/path]`, exactly as the API
 * wrote it (a URL that parsing normalizes into something else, e.g. `%2e%2e`, is dropped).
 */
export function githubUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 300) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !GITHUB_PATH.test(url.pathname) ||
    url.href !== value
  ) {
    return undefined;
  }
  return url.href;
}

export interface VerificationResult {
  readonly programs: readonly ProgramInfo[];
  readonly gaps: readonly AnalysisGap[];
}

/**
 * Adds the verification status to each program. Native programs are not asked (they are part of
 * the validator, not deployed code). "Verified" also requires the verified build's hash to equal
 * the hash Vigil computed from the code deployed now, when both are known; otherwise the
 * program was changed after verification and is reported unverified (`hashMismatch`).
 * API failures (unreachable, timeout, HTTP error, invalid answer) make the status `unknown` with a
 * `PROGRAM_VERIFICATION_UNKNOWN` gap; they never throw.
 */
export async function addVerification(
  programs: readonly ProgramInfo[],
  options: VerificationOptions,
): Promise<VerificationResult> {
  const askable = programs.filter(
    (program) => program.loader !== "native" && program.loader !== "not-a-program",
  );
  if (!options.enabled) {
    return {
      gaps:
        askable.length === 0
          ? []
          : [
              {
                code: "PROGRAM_VERIFICATION_DISABLED",
                message:
                  "program verification lookups are turned off, so no program's verified-build status is known",
              },
            ],
      programs: programs.map((program) =>
        askable.includes(program) ? { ...program, verification: "not-checked" } : program,
      ),
    };
  }
  const gaps: AnalysisGap[] = [];
  const out: ProgramInfo[] = [];
  for (const program of programs) {
    if (!askable.includes(program)) {
      out.push(program);
      continue;
    }
    let status = options.cache.get(program.address);
    if (status === undefined) {
      try {
        const response = await options.http.get(`${VERIFICATION_API}${program.address}`, {
          maxBytes: MAX_RESPONSE_BYTES,
          timeoutMs: VERIFICATION_TIMEOUT_MS,
        });
        if (response.status !== 200) {
          throw new VerificationResponseError(`the API answered HTTP ${response.status}`);
        }
        status = parseVerificationStatus(response.text);
        options.cache.set(program.address, status);
      } catch (error) {
        gaps.push({
          address: program.address,
          code: "PROGRAM_VERIFICATION_UNKNOWN",
          message: `verify.osec.io could not say whether this program is verified: ${describe(error)}`,
        });
        out.push({ ...program, verification: "unknown" });
        continue;
      }
    }
    out.push(withStatus(program, status));
  }
  return { gaps, programs: out };
}

function withStatus(program: ProgramInfo, status: VerificationStatus): ProgramInfo {
  const hashMismatch =
    status.isVerified &&
    program.executableHash !== undefined &&
    status.executableHash !== undefined &&
    status.executableHash !== program.executableHash;
  const details: VerificationDetails = {
    source: "osec",
    ...(status.repoUrl === undefined ? {} : { repoUrl: status.repoUrl }),
    ...(status.commit === undefined ? {} : { commit: status.commit }),
    ...(status.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: status.lastVerifiedAt }),
    ...(status.executableHash === undefined ? {} : { verifiedHash: status.executableHash }),
    ...(hashMismatch ? { hashMismatch: true } : {}),
  };
  return {
    ...program,
    verification: status.isVerified && !hashMismatch ? "verified" : "unverified",
    verificationDetails: details,
  };
}

function describe(error: unknown): string {
  if (error instanceof HttpError || error instanceof VerificationResponseError) {
    return error.message;
  }
  return "unexpected error";
}
