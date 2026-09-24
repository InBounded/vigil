/**
 * The Vigil RPC proxy URL a hosted build is made for, from the `VIGIL_PROXY_URL` environment
 * variable (docs/maintainers.md). Unset or empty: no proxy. Anything but a plain `https:` URL
 * (no credentials, query or fragment) stops the build: the URL ships in the page, so it must not
 * carry a secret, and the CSP only allows `https:` connections.
 */
export function proxyUrlFromEnv(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "") {
    return "";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("VIGIL_PROXY_URL is not a URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("VIGIL_PROXY_URL must be a plain https:// URL (no credentials, query or #)");
  }
  return url.href;
}
