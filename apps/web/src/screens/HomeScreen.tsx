import { type FormEvent, useId, useState } from "react";
import { useMessages } from "../i18n/locale.js";
import { detectInput } from "../lib/detect.js";
import { formatRoute, WEB_CLUSTERS, type WebCluster } from "../lib/routes.js";
import { useSettings } from "../settings/context.js";

/**
 * A real devnet multisig with active proposals (found on 2026-09-23 among the Squads v4 program's
 * recent devnet transactions; see docs/DECISIONS.md, Phase 7). Devnet works with the public
 * endpoint, so the example needs no setup.
 */
export const EXAMPLE_DEVNET_MULTISIG = "3EuviFZiGBE5U4rRs3pjJNP9Z9JGNdux8FR3d5Kw8ZSZ";

/** Start page: one field (multisig address or base64 transaction, detected), the network. */
export default function HomeScreen({ navigate }: { readonly navigate: (hash: string) => void }) {
  const { m } = useMessages();
  const { settings } = useSettings();
  const [value, setValue] = useState("");
  const [cluster, setCluster] = useState<WebCluster>(settings.cluster);
  const [error, setError] = useState<"invalid" | "too-long" | undefined>(undefined);
  const id = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const detected = detectInput(value, cluster);
    if (detected.ok) {
      navigate(formatRoute(detected.route));
    } else {
      setError(detected.reason === "too-long" ? "too-long" : "invalid");
    }
  };
  return (
    <section className="home">
      <h1>{m("home.title")}</h1>
      <p className="lead">{m("home.intro")}</p>
      <form onSubmit={submit} noValidate className="home-form">
        <label htmlFor={`${id}-input`}>{m("home.input")}</label>
        <p id={`${id}-help`} className="help">
          {m("home.input.help")}
        </p>
        <textarea
          id={`${id}-input`}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          value={value}
          aria-invalid={error !== undefined}
          aria-describedby={`${id}-help${error === undefined ? "" : ` ${id}-error`}`}
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
          }}
        />
        {error === undefined ? null : (
          <p id={`${id}-error`} className="field-error">
            {m(error === "too-long" ? "home.input.tooLong" : "home.input.invalid")}
          </p>
        )}
        <label htmlFor={`${id}-cluster`}>{m("home.network")}</label>
        <select
          id={`${id}-cluster`}
          value={cluster}
          onChange={(event) => {
            const next = WEB_CLUSTERS.find((c) => c === event.target.value);
            if (next !== undefined) {
              setCluster(next);
            }
          }}
        >
          {WEB_CLUSTERS.map((c) => (
            <option key={c} value={c}>
              {m(`cluster.${c}`)}
            </option>
          ))}
        </select>
        <div className="actions">
          <button type="submit" className="button-primary">
            {m("home.submit")}
          </button>
          <button
            type="button"
            className="button"
            aria-describedby={`${id}-example`}
            onClick={() => {
              setValue(EXAMPLE_DEVNET_MULTISIG);
              setCluster("devnet");
              setError(undefined);
            }}
          >
            {m("home.example")}
          </button>
        </div>
        <p id={`${id}-example`} className="help">
          {m("home.example.help")}
        </p>
      </form>
      <ul className="home-notes">
        <li>{m("home.notes.1")}</li>
        <li>{m("home.notes.2")}</li>
      </ul>
    </section>
  );
}
