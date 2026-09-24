import { describe, expect, it } from "vitest";
import { corsHeaders, parseAllowedOrigins, preflightHeaders } from "./cors.js";

describe("parseAllowedOrigins", () => {
  it("keeps exact https origins and loopback http origins, trimmed", () => {
    expect([
      ...parseAllowedOrigins(
        " https://vigil.example ,https://a.pages.dev,http://localhost:5173, http://127.0.0.1:4173,http://[::1]:8080",
      ),
    ]).toEqual([
      "https://vigil.example",
      "https://a.pages.dev",
      "http://localhost:5173",
      "http://127.0.0.1:4173",
      "http://[::1]:8080",
    ]);
  });

  it.each([
    undefined,
    "",
    "*",
    "null",
    "vigil.example",
    "https://vigil.example/",
    "https://vigil.example/app",
    "https://vigil.example?x=1",
    "HTTPS://VIGIL.EXAMPLE",
    "http://vigil.example",
    "http://localhost.evil.example",
    "https://user:pass@vigil.example",
    "ftp://vigil.example",
    "file:///index.html",
  ])("ignores %j", (raw) => {
    expect(parseAllowedOrigins(raw).size).toBe(0);
  });
});

describe("headers", () => {
  it("names one origin and varies on Origin", () => {
    expect(corsHeaders("https://vigil.example")).toEqual({
      "Access-Control-Allow-Origin": "https://vigil.example",
      Vary: "Origin",
    });
    expect(preflightHeaders("https://vigil.example")).toMatchObject({
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Max-Age": "86400",
    });
  });
});
