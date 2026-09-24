/**
 * The web app's own source never turns strings into markup or code: no `dangerouslySetInnerHTML`,
 * `innerHTML`/`outerHTML`/`insertAdjacentHTML`, `document.write`, `eval`, `new Function`,
 * string timers, `srcdoc` or `javascript:` URLs. Biome's security rules catch some of these at
 * lint time; this test catches all of them, in every source file of the app and its build config.
 * It also keeps invisible characters out of the source (they could hide code from a reviewer).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

const BANNED: readonly [string, RegExp][] = [
  ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
  ["innerHTML", /\.innerHTML\b/],
  ["outerHTML", /\.outerHTML\b/],
  ["insertAdjacentHTML", /insertAdjacentHTML/],
  ["document.write", /document\.write(?:ln)?\s*\(/],
  ["eval", /(?<![\w.])eval\s*\(/],
  ["new Function", /new\s+Function\s*\(/],
  ["string timer", /set(?:Timeout|Interval)\s*\(\s*["'`]/],
  ["srcdoc", /srcdoc/i],
  ["javascript: URL", /javascript:/i],
  ["createContextualFragment", /createContextualFragment/],
  ["DOMParser", /DOMParser/],
];

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;

/** Source files of the app: `src/` (tests excluded: they name the banned APIs), `scripts/`, configs. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.(tsx?|css|html)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(path);
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "scripts"));
  out.push(join(ROOT, "vite.config.ts"), join(ROOT, "vitest.config.ts"), join(ROOT, "index.html"));
  return out;
}

describe("web source hygiene", () => {
  it("scans the app's sources", () => {
    expect(sources().length).toBeGreaterThan(30);
  });

  it.each(BANNED)("never uses %s", (_name, pattern) => {
    const offenders = sources().filter((file) => pattern.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it("has no invisible characters in any source file, tests included", () => {
    const all = [...sources()];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (/\.test\.tsx?$/.test(name)) {
          all.push(path);
        }
      }
    };
    walk(join(ROOT, "src"));
    const offenders = all.filter((file) => INVISIBLE.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it("the patterns do catch what they are for", () => {
    const probes: Record<string, string> = {
      DOMParser: "new DOMParser()",
      createContextualFragment: "range.createContextualFragment(x)",
      dangerouslySetInnerHTML: "<div dangerouslySetInnerHTML={{ __html: x }} />",
      "document.write": "document.write(x)",
      eval: "const y = eval(x)",
      innerHTML: "el.innerHTML = x",
      insertAdjacentHTML: "el.insertAdjacentHTML('beforeend', x)",
      "javascript: URL": 'href="javascript:alert(1)"',
      "new Function": "new Function(x)",
      outerHTML: "el.outerHTML = x",
      srcdoc: "<iframe srcDoc={x} />",
      "string timer": 'setTimeout("alert(1)", 0)',
    };
    for (const [name, pattern] of BANNED) {
      expect(pattern.test(probes[name] ?? ""), name).toBe(true);
    }
    expect(/(?<![\w.])eval\s*\(/.test("retrieval(x)")).toBe(false);
  });
});
