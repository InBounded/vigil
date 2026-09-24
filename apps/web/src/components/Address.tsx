import { isAddress } from "@solana/kit";
import { createContext, type ReactNode, useContext } from "react";
import { useMessages } from "../i18n/locale.js";
import { explorerLinks } from "../lib/explorer.js";
import { CopyButton } from "./CopyButton.js";

/**
 * Addresses flagged as possible address poisoning (VGL-C008), each with the known address it
 * imitates: wherever such an address appears, it is highlighted with the differing characters
 * marked.
 */
export const PoisonContext = createContext<ReadonlyMap<string, string>>(new Map());

/** Network of the data on the page, for explorer links. */
export const ClusterContext = createContext<string>("unknown");

/**
 * An address: always full, monospace, in groups of four for comparison (visual gaps only, so a
 * copied selection is the exact address), with a copy button, its label when known, and
 * optionally links to Solana Explorer and Solscan.
 */
export function Address({
  address,
  label,
  links = false,
  compareWith,
}: {
  readonly address: string;
  readonly label?: string | undefined;
  readonly links?: boolean;
  readonly compareWith?: string | undefined;
}) {
  const { m } = useMessages();
  const poisoned = useContext(PoisonContext);
  const cluster = useContext(ClusterContext);
  const other = compareWith ?? poisoned.get(address);
  const urls = links && isAddress(address) ? explorerLinks(address, cluster) : undefined;
  return (
    <span className={other === undefined ? "address" : "address address-poisoned"}>
      {label === undefined ? null : <span className="address-label">{label}</span>}
      <code className="address-value" translate="no">
        {groups(address, other)}
      </code>
      {other === undefined ? null : (
        <span className="visually-hidden">{m("address.differs", { other })}</span>
      )}
      <CopyButton
        text={address}
        label={m("address.copy")}
        copiedLabel={m("address.copied")}
        failedLabel={m("address.copyFailed")}
        className="button-icon"
      />
      {urls === undefined ? null : (
        <span className="address-links">
          <a href={urls.explorer} target="_blank" rel="noopener noreferrer">
            {m("address.explorer")}
          </a>
          <a href={urls.solscan} target="_blank" rel="noopener noreferrer">
            {m("address.solscan")}
          </a>
        </span>
      )}
    </span>
  );
}

/** Groups of four characters; characters that differ from `other` at the same position marked. */
function groups(address: string, other: string | undefined): ReactNode[] {
  const out: ReactNode[] = [];
  for (let start = 0; start < address.length; start += 4) {
    const chunk = address.slice(start, start + 4);
    const parts: ReactNode[] = [];
    let plain = "";
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i] ?? "";
      if (other !== undefined && other[start + i] !== char) {
        if (plain !== "") {
          parts.push(plain);
          plain = "";
        }
        parts.push(<mark key={`${start + i}`}>{char}</mark>);
      } else {
        plain += char;
      }
    }
    if (plain !== "") {
      parts.push(plain);
    }
    out.push(
      <span className="address-group" key={start}>
        {parts}
      </span>,
    );
  }
  return out;
}

/** Base58 runs long enough to be an address; each is checked with `isAddress` before use. */
const CANDIDATE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/**
 * A sentence from core's catalogs (rendered with full addresses), with every address in it shown
 * as an `Address`. The text itself is only ever rendered as text.
 */
export function TextWithAddresses({ text }: { readonly text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const value = match[0];
    const at = match.index;
    if (!isAddress(value)) {
      continue;
    }
    if (at > last) {
      parts.push(text.slice(last, at));
    }
    parts.push(<Address key={`${at}`} address={value} />);
    last = at + value.length;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return <>{parts}</>;
}
