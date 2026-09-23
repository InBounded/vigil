import { CONFUSABLES } from "./confusables.generated.js";

function mapConfusables(text: string): string {
  let out = "";
  for (const char of text) {
    out += CONFUSABLES.get(char) ?? char;
  }
  return out;
}

/**
 * The forms a token name or symbol is compared in, so that look-alikes compare equal: NFKC
 * (fullwidth and styled letters), confusable characters mapped to the ASCII letter or digit they
 * resemble (Cyrillic `С` → `C`, `0` → `O`), lower case, letters and digits only. Two forms because
 * the confusables table is case-sensitive (`I` → `l` but `i` stays `i`): one maps before
 * lower-casing, one after. Two strings look alike when they share a non-empty form.
 */
export function lookAlikeForms(text: string): ReadonlySet<string> {
  const normalized = text.normalize("NFKC");
  const forms = [mapConfusables(normalized), mapConfusables(normalized.toLowerCase())].map((form) =>
    form.toLowerCase().replace(/[^a-z0-9]/g, ""),
  );
  return new Set(forms.filter((form) => form !== ""));
}

export function looksAlike(a: string, b: string): boolean {
  const formsOfB = lookAlikeForms(b);
  return [...lookAlikeForms(a)].some((form) => formsOfB.has(form));
}
