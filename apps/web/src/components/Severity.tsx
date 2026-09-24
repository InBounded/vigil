import type { Severity as SeverityLevel, Verdict } from "@vigil-sol/core";
import { useMessages } from "../i18n/locale.js";

/** Symbols carry meaning together with the word and the colour, never alone. */
const SEVERITY_SYMBOL: Readonly<Record<SeverityLevel, string>> = {
  critical: "✖",
  info: "ℹ",
  warning: "⚠",
};

/** Deliberately no check mark for "no findings": it is not "safe". */
export const VERDICT_SYMBOL: Readonly<Record<Verdict, string>> = {
  attention: "⚠",
  critical: "✖",
  incomplete: "?",
  "no-findings": "○",
};

export function SeverityBadge({ severity }: { readonly severity: SeverityLevel }) {
  const { m } = useMessages();
  return (
    <span className={`badge badge-${severity}`}>
      <span aria-hidden="true">{SEVERITY_SYMBOL[severity]}</span> {m(`severity.${severity}`)}
    </span>
  );
}
