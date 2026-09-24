export type BodyRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "too-large" | "not-utf8" };

/**
 * Reads a request body of at most `maxBytes`. `Content-Length` is checked first, and the stream is
 * counted as it is read, so a missing or false header cannot get a larger body through.
 */
export async function readBody(request: Request, maxBytes: number): Promise<BodyRead> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && !(/^\d+$/.test(declared) && Number(declared) <= maxBytes)) {
    return { ok: false, reason: "too-large" };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    };
  } catch {
    return { ok: false, reason: "not-utf8" };
  }
}
