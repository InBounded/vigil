import { readFile } from "node:fs/promises";
import type { HttpClient, HttpGetOptions, HttpResponse } from "../io/http.js";
import { fixturePath } from "./rules.js";

/** A fixture written by `scripts/capture-verification.ts`: real API answers, verbatim. */
interface RecordedResponses {
  readonly endpoint: string;
  readonly responses: Readonly<Record<string, HttpResponse>>;
}

/** An `HttpClient` replaying recorded answers; it counts calls and refuses unknown URLs. */
export class ReplayHttpClient implements HttpClient {
  readonly calls: { readonly url: string; readonly options: HttpGetOptions }[] = [];
  readonly #recorded: RecordedResponses;

  constructor(recorded: RecordedResponses) {
    this.#recorded = recorded;
  }

  get(url: string, options: HttpGetOptions): Promise<HttpResponse> {
    this.calls.push({ options, url });
    const program = url.startsWith(this.#recorded.endpoint)
      ? url.slice(this.#recorded.endpoint.length)
      : undefined;
    const response = program === undefined ? undefined : this.#recorded.responses[program];
    if (response === undefined) {
      return Promise.reject(new Error(`no recorded answer for ${url}`));
    }
    return Promise.resolve(response);
  }
}

export async function loadRecordedHttp(name: string): Promise<ReplayHttpClient> {
  const text = await readFile(fixturePath(name), "utf8");
  return new ReplayHttpClient(JSON.parse(text) as RecordedResponses);
}

/** An `HttpClient` that always fails the given way (for API outage tests). */
export function failingHttp(fail: () => Promise<HttpResponse>): HttpClient & { calls: number } {
  const client = {
    calls: 0,
    get(): Promise<HttpResponse> {
      client.calls++;
      return fail();
    },
  };
  return client;
}
