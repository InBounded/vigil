import { readFile } from "node:fs/promises";
import { delimiter } from "node:path";
import {
  type Clock,
  FixtureRpcClient,
  type HttpClient,
  type HttpGetOptions,
  type HttpResponse,
  type RpcClient,
} from "@vigil-sol/core";
import { loadFixtureFiles } from "@vigil-sol/core/node";

/**
 * Test-only: when `NODE_ENV` is `test` and `VIGIL_TEST_FIXTURES` lists fixture files (separated by
 * the platform path delimiter), every RPC client the CLI creates replays those real captured
 * answers instead of using the network, so the integration tests can run the real binary offline.
 * The RPC URL is still validated, redacted and reduced to its host exactly as in a live run; only
 * the transport changes. `VIGIL_TEST_HTTP_FIXTURE` replays recorded verification API answers (else
 * every request fails), `VIGIL_TEST_CROSS_CHECK_FIXTURES` gives the second RPC different data, and
 * `VIGIL_TEST_NOW` (ISO 8601) fixes the clock. Nothing here can send anything anywhere.
 */
export interface FixtureMode {
  readonly createRpc: (url: string) => RpcClient;
  readonly createHttp: () => HttpClient;
  readonly clock?: Clock;
}

export async function fixtureMode(
  env: Readonly<Record<string, string | undefined>>,
): Promise<FixtureMode | undefined> {
  const files = env.VIGIL_TEST_FIXTURES;
  if (env.NODE_ENV !== "test" || files === undefined || files === "") {
    return undefined;
  }
  const primary = await loadFixtureFiles(files.split(delimiter));
  const crossFiles = env.VIGIL_TEST_CROSS_CHECK_FIXTURES;
  const secondary =
    crossFiles === undefined || crossFiles === ""
      ? primary
      : await loadFixtureFiles(crossFiles.split(delimiter));
  let created = 0;
  const httpFile = env.VIGIL_TEST_HTTP_FIXTURE;
  const recorded =
    httpFile === undefined || httpFile === ""
      ? undefined
      : (JSON.parse(await readFile(httpFile, "utf8")) as RecordedHttp);
  const now = env.VIGIL_TEST_NOW === undefined ? undefined : Date.parse(env.VIGIL_TEST_NOW);
  return {
    // The first client is the primary RPC, any later one the cross-check RPC.
    createHttp: () => new ReplayHttpClient(recorded),
    createRpc: () => new FixtureRpcClient(created++ === 0 ? primary : secondary),
    ...(now === undefined || Number.isNaN(now) ? {} : { clock: { now: () => now } }),
  };
}

interface RecordedHttp {
  readonly endpoint: string;
  readonly responses: Readonly<Record<string, HttpResponse>>;
}

class ReplayHttpClient implements HttpClient {
  readonly #recorded: RecordedHttp | undefined;

  constructor(recorded: RecordedHttp | undefined) {
    this.#recorded = recorded;
  }

  get(url: string, _options: HttpGetOptions): Promise<HttpResponse> {
    const recorded = this.#recorded;
    const key =
      recorded !== undefined && url.startsWith(recorded.endpoint)
        ? url.slice(recorded.endpoint.length)
        : undefined;
    const response = key === undefined ? undefined : recorded?.responses[key];
    return response === undefined
      ? Promise.reject(new Error("no recorded answer"))
      : Promise.resolve(response);
  }
}
