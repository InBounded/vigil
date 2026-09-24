import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.js";
import { fixtureMode } from "./fixture-mode.js";
import { exitCodeFrom } from "./runtime.js";
import { checkRpcUrl } from "./secrets.js";
import { createStyle, layoutWidth, terminalSafe, wrap } from "./terminal.js";
import { parseBase64Transaction } from "./validate.js";

describe("exit codes", () => {
  const state = (critical: boolean, incomplete: boolean, warning: boolean) => ({
    critical,
    incomplete,
    warning,
  });
  it("follow the documented table", () => {
    // [critical, incomplete, warning] → [critical, warning, never]
    const table: [[boolean, boolean, boolean], [number, number, number]][] = [
      [
        [false, false, false],
        [0, 0, 0],
      ],
      [
        [false, false, true],
        [0, 1, 0],
      ],
      [
        [false, true, false],
        [4, 4, 0],
      ],
      [
        [false, true, true],
        [4, 4, 0],
      ],
      [
        [true, false, false],
        [2, 2, 0],
      ],
      [
        [true, true, true],
        [2, 2, 0],
      ],
    ];
    for (const [[c, i, w], [onCritical, onWarning, never]] of table) {
      expect(exitCodeFrom(state(c, i, w), "critical")).toBe(onCritical);
      expect(exitCodeFrom(state(c, i, w), "warning")).toBe(onWarning);
      expect(exitCodeFrom(state(c, i, w), "never")).toBe(never);
    }
  });
});

describe("parseCliArgs", () => {
  it("gives the documented defaults", () => {
    const parsed = parseCliArgs(["decode", "a", "1"]);
    expect(parsed.global).toEqual({
      cluster: "mainnet",
      clusterGiven: false,
      crossCheckRpcFlag: undefined,
      external: true,
      failOn: "critical",
      history: 0,
      json: false,
      locale: "en",
      rpcFlag: undefined,
      simulate: true,
      verbose: false,
    });
    expect(parsed).toMatchObject({ limit: 20, positionals: ["a", "1"], status: "active" });
  });
});

describe("RPC URL policy", () => {
  const flag = { flag: "--rpc", fromFlag: true, variable: "VIGIL_RPC_URL" };
  const variable = { ...flag, fromFlag: false };
  it("accepts a plain endpoint anywhere and a keyed one only from the environment", () => {
    expect(checkRpcUrl("https://api.example.com", flag).host).toBe("api.example.com");
    expect(checkRpcUrl("http://127.0.0.1:8899/", flag).host).toBe("127.0.0.1:8899");
    expect(checkRpcUrl("https://api.example.com/v2/KEY", variable).pathname).toBe("/v2/KEY");
    for (const url of [
      "https://a.example/KEY",
      "https://a.example/?k=1",
      "https://u:p@a.example",
    ]) {
      expect(() => checkRpcUrl(url, flag)).toThrow(/may contain an API key/);
    }
  });

  it("refuses what is not an http(s) URL", () => {
    expect(() => checkRpcUrl("not a url", variable)).toThrow("VIGIL_RPC_URL is not a valid URL.");
    expect(() => checkRpcUrl("wss://a.example", flag)).toThrow("must be an http(s) URL");
  });
});

describe("terminal output", () => {
  it("strips control, bidi and zero-width characters from data", () => {
    const esc = String.fromCharCode(27);
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    const tag = String.fromCodePoint(0xe0041);
    expect(terminalSafe(`a${esc}[31mb${rlo}c${zwsp}d${tag}e\tf\ng`)).toBe("a[31mbcdef\ng");
  });

  it("wraps on spaces, never inside a word", () => {
    const address = "81S2mzdgrTGVjHHiJGiN2bCt8hjaiBvoNqVmYyRVzuJf";
    expect(wrap(`to ${address} now`, 20, "  ", "    ")).toEqual([
      "  to",
      `    ${address}`,
      "    now",
    ]);
    expect(wrap("one two three", 9, "> ")).toEqual(["> one two", "> three"]);
    expect(wrap("a\nb", 80)).toEqual(["a", "b"]);
  });

  it("keeps the layout between 40 and 100 columns; 80 when not a terminal", () => {
    expect(layoutWidth(false, 200)).toBe(80);
    expect(layoutWidth(true, undefined)).toBe(80);
    expect(layoutWidth(true, 20)).toBe(40);
    expect(layoutWidth(true, 300)).toBe(100);
    expect(layoutWidth(true, 63.7)).toBe(63);
  });

  it("colour follows NO_COLOR, FORCE_COLOR, TERM=dumb and whether it is a terminal", () => {
    expect(createStyle({}, true).enabled).toBe(true);
    expect(createStyle({}, false).enabled).toBe(false);
    expect(createStyle({ NO_COLOR: "1" }, true).enabled).toBe(false);
    expect(createStyle({ NO_COLOR: "" }, true).enabled).toBe(true);
    expect(createStyle({ TERM: "dumb" }, true).enabled).toBe(false);
    expect(createStyle({ FORCE_COLOR: "1" }, false).enabled).toBe(true);
    expect(createStyle({ FORCE_COLOR: "0" }, false).enabled).toBe(false);
    expect(createStyle({ FORCE_COLOR: "1", NO_COLOR: "1" }, true).enabled).toBe(false);
  });
});

describe("base64 input", () => {
  it("ignores whitespace and line breaks, and needs valid padding", () => {
    expect(parseBase64Transaction(" AAAA\nBBBB \n")).toBe("AAAABBBB");
    expect(() => parseBase64Transaction("AAA")).toThrow("not valid base64");
    expect(() => parseBase64Transaction("   ")).toThrow("The transaction is empty.");
  });
});

describe("test-only fixture mode", () => {
  it("is off unless NODE_ENV is test and fixtures are given", async () => {
    expect(await fixtureMode({ VIGIL_TEST_FIXTURES: "/x.json" })).toBeUndefined();
    expect(
      await fixtureMode({ NODE_ENV: "production", VIGIL_TEST_FIXTURES: "/x.json" }),
    ).toBeUndefined();
    expect(await fixtureMode({ NODE_ENV: "test" })).toBeUndefined();
    expect(await fixtureMode({ NODE_ENV: "test", VIGIL_TEST_FIXTURES: "" })).toBeUndefined();
  });
});
