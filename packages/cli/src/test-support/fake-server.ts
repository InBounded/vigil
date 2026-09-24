/**
 * A local HTTP server standing in for Discord and Telegram in tests: it records every request and
 * answers from a script. Listens on 127.0.0.1 only. Not shipped.
 */
import { createServer, type Server } from "node:http";

export interface RecordedRequest {
  readonly method: string;
  /** `/<original host><original path and query>` (see `fetchNotifierHttp`'s test redirect). */
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export interface ScriptedResponse {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FakeServer {
  readonly origin: string;
  readonly requests: RecordedRequest[];
  /** Answers for the next requests, in order; when empty, `fallback` answers. */
  readonly script: ScriptedResponse[];
  fallback: ScriptedResponse;
  /** When set, answers every request instead of the script and the fallback. */
  handler: ((request: RecordedRequest) => ScriptedResponse) | undefined;
  close(): Promise<void>;
}

export async function startFakeServer(
  fallback: ScriptedResponse = { body: '{"ok":true}', status: 200 },
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const script: ScriptedResponse[] = [];
  const state: {
    fallback: ScriptedResponse;
    handler: ((request: RecordedRequest) => ScriptedResponse) | undefined;
  } = { fallback, handler: undefined };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const recorded: RecordedRequest = {
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers,
        method: request.method ?? "",
        path: request.url ?? "",
      };
      requests.push(recorded);
      const answer = state.handler?.(recorded) ?? script.shift() ?? state.fallback;
      response.writeHead(answer.status, {
        "content-type": "application/json",
        ...answer.headers,
      });
      response.end(answer.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake server has no port");
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
    get fallback() {
      return state.fallback;
    },
    set fallback(value: ScriptedResponse) {
      state.fallback = value;
    },
    get handler() {
      return state.handler;
    },
    set handler(value) {
      state.handler = value;
    },
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    script,
  };
}
